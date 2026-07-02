import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../auth/jwt.js';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = verifyToken(authHeader.slice(7));
    req.auth = { userId: payload.sub, email: payload.email };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function resolveAuthUserId(token: string): string {
  const payload = verifyToken(token);
  return payload.sub;
}
