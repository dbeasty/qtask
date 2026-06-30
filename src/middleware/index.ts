import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';

export function getUserId(req: Request): string {
  return (req.headers['x-user-id'] as string) || config.defaultUserId;
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' });
}
