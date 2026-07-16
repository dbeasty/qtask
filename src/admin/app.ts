import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from '../config/index.js';
import { connectDb } from '../db/connection.js';
import { errorHandler, notFoundHandler } from '../middleware/index.js';
import {
  adminLogout,
  adminSession,
  mtlsLogin,
  passwordLogin,
  requireAdmin,
  requireCsrf,
} from './auth.js';
import { adminRouter } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createAdminApp(options?: { connect?: boolean; serveClient?: boolean }) {
  if (options?.connect ?? true) await connectDb();

  if (config.nodeEnv === 'production' && !config.admin.jwtSecret) {
    throw new Error('ADMIN_JWT_SECRET is required for the admin application');
  }
  if (
    config.nodeEnv === 'production' &&
    config.admin.authMode === 'password' &&
    !config.admin.password
  ) {
    throw new Error('ADMIN_PASSWORD is required in password admin auth mode');
  }
  if (
    config.nodeEnv === 'production' &&
    config.admin.authMode === 'mtls' &&
    !config.admin.proxySecret
  ) {
    throw new Error('ADMIN_PROXY_SECRET is required in mTLS admin auth mode');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.nodeEnv === 'test' ? 10_000 : 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many admin login attempts' },
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'qtask-admin' });
  });
  app.get('/api/admin/auth/session', adminSession);
  app.post('/api/admin/auth/login', loginLimiter, passwordLogin);
  app.post('/api/admin/auth/mtls', loginLimiter, mtlsLogin);
  app.post('/api/admin/auth/logout', requireAdmin, requireCsrf, adminLogout);
  app.use('/api/admin', adminRouter);

  if (options?.serveClient ?? config.nodeEnv === 'production') {
    const clientDist =
      config.admin.clientDist ?? path.resolve(__dirname, '../../admin-client/dist');
    app.use(express.static(clientDist));
    app.get(/^(?!\/api).*/, (_req, res, next) => {
      res.sendFile(path.join(clientDist, 'index.html'), (error) => {
        if (error) next();
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
