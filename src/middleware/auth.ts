import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { decodeTokenUnsafe, verifyToken, type JwtPayload } from '../auth/jwt.js';
import { UserModel } from '../models/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('auth');

export const REFRESH_GRACE_MS = 5 * 60 * 1000;

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

function authMeta(req: Request) {
  return { path: req.path, method: req.method };
}

function expiredAgoMsFromToken(token: string): number | undefined {
  const meta = decodeTokenUnsafe(token);
  if (meta.exp == null) return undefined;
  const ago = Date.now() - meta.exp * 1000;
  return ago > 0 ? ago : undefined;
}

function setAuthFromPayload(req: Request, payload: JwtPayload): void {
  req.auth = {
    userId: payload.sub,
    email: payload.email,
    mustChangePassword: payload.pwd_change === true,
  };
}

function authenticate(allowPasswordChange: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      logger.info('Authentication failed', {
        reason: 'missing_token',
        ...authMeta(req),
      });
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const payload = verifyToken(token);
      if (payload.pwd_change && !allowPasswordChange) {
        logger.info('Password change required', {
          reason: 'password_change_required',
          userId: payload.sub,
          ...authMeta(req),
        });
        res.status(403).json({
          error: 'Password change required',
          code: 'PASSWORD_CHANGE_REQUIRED',
        });
        return;
      }
      setAuthFromPayload(req, payload);
      recordActivity(payload.sub);
      next();
    } catch (err) {
      const meta = decodeTokenUnsafe(token);
      const expiredAgoMs =
        err instanceof jwt.TokenExpiredError && meta.exp != null
          ? Date.now() - meta.exp * 1000
          : expiredAgoMsFromToken(token);

      logger.warn('Authentication failed', {
        reason: 'invalid_or_expired',
        userId: meta.sub,
        expiredAgoMs,
        ...authMeta(req),
      });
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

function verifyTokenForRefresh(token: string): JwtPayload | null {
  try {
    return verifyToken(token);
  } catch (err) {
    if (!(err instanceof jwt.TokenExpiredError)) {
      return null;
    }
    const meta = decodeTokenUnsafe(token);
    if (meta.exp == null || meta.sub == null) {
      return null;
    }
    const expiredAgoMs = Date.now() - meta.exp * 1000;
    if (expiredAgoMs < 0 || expiredAgoMs > REFRESH_GRACE_MS) {
      return null;
    }
    try {
      return jwt.verify(token, config.jwtSecret, { ignoreExpiration: true }) as JwtPayload;
    } catch {
      return null;
    }
  }
}

export function requireAuthForRefresh(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn('Refresh rejected', {
      reason: 'refresh_rejected',
      failure: 'missing_token',
      ...authMeta(req),
    });
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyTokenForRefresh(token);

  if (!payload) {
    const expiredAgoMs = expiredAgoMsFromToken(token);
    const meta = decodeTokenUnsafe(token);
    const failure =
      errFailureKind(token, expiredAgoMs) ?? 'invalid_signature';

    logger.warn('Refresh rejected', {
      reason: 'refresh_rejected',
      failure,
      userId: meta.sub,
      expiredAgoMs,
      ...authMeta(req),
    });
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (expiredAgoMsFromToken(token) != null) {
    logger.info('Grace refresh accepted', {
      reason: 'grace_refresh',
      userId: payload.sub,
      expiredAgoMs: expiredAgoMsFromToken(token),
      ...authMeta(req),
    });
  }

  setAuthFromPayload(req, payload);
  next();
}

function errFailureKind(
  token: string,
  expiredAgoMs: number | undefined
): 'outside_grace' | 'invalid_signature' | undefined {
  const meta = decodeTokenUnsafe(token);
  if (meta.error) return 'invalid_signature';
  if (expiredAgoMs != null && expiredAgoMs > REFRESH_GRACE_MS) return 'outside_grace';
  if (expiredAgoMs != null) {
    try {
      jwt.verify(token, config.jwtSecret, { ignoreExpiration: true });
    } catch {
      return 'invalid_signature';
    }
  }
  return undefined;
}

export const requireAuth = authenticate(false);
export const requirePasswordChangeAuth = authenticate(true);

export function resolveAuthUserId(token: string): string {
  const payload = verifyToken(token);
  return payload.sub;
}
