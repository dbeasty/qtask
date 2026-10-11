/**
 * The routes and gates that only exist in local mode, plus GET /api/version, which
 * exists in both modes so a client can ask "what am I talking to?" before it decides
 * which UI to show.
 */

import { Router, type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { getDataHealth } from '../data/index.js';
import { APP_VERSION, GIT_SHA } from '../version.js';
import { createLocalSession, requireDeviceToken } from './auth.js';
import { runtimeMode, type LocalConfig } from './config.js';
import { loadOrCreateDeviceIdentity } from './device.js';

export const versionHandler: RequestHandler = (_req, res) => {
  res.json({
    service: 'qtask',
    version: APP_VERSION,
    gitSha: GIT_SHA,
    mode: runtimeMode(),
  });
};

/**
 * The only /api/auth endpoints that mean anything on a device with no accounts: read
 * and update the one profile, and refresh the session. Everything else (register, log
 * in, passwords, e-mail verification, OAuth) is unmounted, so it answers 404 exactly as
 * if it had never existed.
 */
const LOCAL_AUTH_ALLOWED = new Set(['GET /me', 'PATCH /me', 'POST /refresh', 'GET /config', 'POST /local-session']);

export function localAuthGate(req: Request, res: Response, next: NextFunction): void {
  if (LOCAL_AUTH_ALLOWED.has(`${req.method} ${req.path}`)) {
    next();
    return;
  }
  res.status(404).json({ error: 'Not available in local mode' });
}

/** GET /api/auth/config as the sign-in screen would read it: nothing to sign in to. */
const localAuthConfig: RequestHandler = (_req, res) => {
  res.json({ registrationEnabled: false, oauthProviders: [], mode: 'local' });
};

/**
 * Everything local mode puts in front of the regular routes. Must be called before any
 * other route is mounted: the device-token check has to be the first thing a request
 * meets.
 */
export function mountLocalPreamble(app: Express, local: LocalConfig): void {
  app.use(requireDeviceToken(local.deviceToken));

  app.get('/health', (_req, res) => {
    const identity = loadOrCreateDeviceIdentity(local.dataDir);
    res.json({
      status: 'ok',
      service: 'qtask',
      mode: 'local',
      version: APP_VERSION,
      gitSha: GIT_SHA,
      deviceId: identity.deviceId,
      data: getDataHealth(),
    });
  });

  const auth = Router();
  auth.get('/config', localAuthConfig);
  auth.post('/local-session', async (_req, res, next) => {
    try {
      res.json(await createLocalSession());
    } catch (error) {
      next(error);
    }
  });
  app.use('/api/auth', localAuthGate, auth);
}
