import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../auth/jwt.js';
import { UserModel } from '../models/index.js';

const ACTIVITY_WRITE_INTERVAL_MS = 15 * 60 * 1000;
const activityWrites = new Map<string, number>();

function recordActivity(userId: string): void {
  const now = Date.now();
  const previous = activityWrites.get(userId) ?? 0;
  if (now - previous < ACTIVITY_WRITE_INTERVAL_MS) return;
  activityWrites.set(userId, now);
  const cleanup = setTimeout(() => {
    if (activityWrites.get(userId) === now) activityWrites.delete(userId);
  }, ACTIVITY_WRITE_INTERVAL_MS);
  cleanup.unref();
  void UserModel.updateOne({ _id: userId }, { $set: { lastActiveAt: new Date(now) } }).catch(() => {
    activityWrites.delete(userId);
  });
}

function authenticate(allowPasswordChange: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = verifyToken(authHeader.slice(7));
    if (payload.pwd_change && !allowPasswordChange) {
      res.status(403).json({
        error: 'Password change required',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
      return;
    }
    req.auth = {
      userId: payload.sub,
      email: payload.email,
      mustChangePassword: payload.pwd_change === true,
    };
    recordActivity(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
  };
}

export const requireAuth = authenticate(false);
export const requirePasswordChangeAuth = authenticate(true);

export function resolveAuthUserId(token: string): string {
  const payload = verifyToken(token);
  return payload.sub;
}
