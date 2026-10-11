/**
 * Local-device authentication.
 *
 * There are no accounts in local mode. Two layers replace them:
 *
 *  1. `requireDeviceToken` runs before everything else and rejects any request that does
 *     not carry this launch's device token. The server only listens on loopback, but
 *     loopback is reachable by every other process (and every web page) on the Mac;
 *     the token is what makes "only my app" true.
 *  2. `POST /api/auth/local-session` turns a request holding the token into an ordinary
 *     session JWT for the one local user, so the rest of the backend and the web client
 *     keep working unchanged: they only ever see a Bearer token.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { collection } from '../data/index.js';
import { authService } from '../services/authService.js';
import { projectService } from '../services/projectService.js';
import { DEVICE_TOKEN_HEADER } from './config.js';
import type { UserDoc } from '../data/documents.js';

/** Fixed e-mail of the local user. It is not a mailbox and never receives mail. */
export const LOCAL_USER_EMAIL = 'local@device.qtask.invalid';

export function tokensMatch(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual needs equal lengths; comparing against itself keeps the work the
  // same for a wrong-length guess.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function requireDeviceToken(expected: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!tokensMatch(req.headers[DEVICE_TOKEN_HEADER], expected)) {
      res.status(403).json({ error: 'Not a local device request' });
      return;
    }
    next();
  };
}

/** Finds or creates the one local user (and its default project). Idempotent. */
export async function ensureLocalUser(): Promise<UserDoc> {
  const users = collection<UserDoc>('users');
  let user = await users.findOne({ email: LOCAL_USER_EMAIL });
  if (!user) {
    user = await users.create({
      email: LOCAL_USER_EMAIL,
      displayName: 'Me',
      emailVerified: true,
    });
  }
  await projectService.ensureDefaultProject(String(user._id));
  return user;
}

/** Issues a session for the local user. */
export async function createLocalSession() {
  const user = await ensureLocalUser();
  return authService.createSessionForUserId(String(user._id));
}
