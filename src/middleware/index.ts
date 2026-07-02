import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../utils/httpError.js';
import { config } from '../config/index.js';

export function getUserId(req: Request): string {
  if (!req.auth?.userId) {
    throw new HttpError(401, 'Authentication required');
  }
  return req.auth.userId;
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  console.error(err);
  const message =
    config.nodeEnv === 'production' ? 'Internal server error' : err.message || 'Internal server error';
  res.status(500).json({ error: message });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' });
}
