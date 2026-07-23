import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { connectDb } from './db/connection.js';
import { projectsRouter } from './routes/projects.js';
import { tasksRouter } from './routes/tasks.js';
import { agentRouter } from './routes/agent.js';
import { authRouter } from './routes/auth.js';
import { searchRouter } from './routes/search.js';
import { errorHandler, notFoundHandler } from './middleware/index.js';
import { requireAuth } from './middleware/auth.js';
import { startEmbeddingWorker } from './services/embeddingQueue.js';
import { config } from './config/index.js';
import { initEmail, getEmailStatus } from './services/emailService.js';
import { APP_VERSION } from './version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createApp(options?: { connect?: boolean; startWorker?: boolean }) {
  const shouldConnect = options?.connect ?? true;
  const shouldStartWorker = options?.startWorker ?? true;

  if (shouldConnect) {
    await connectDb();
    const { projectService } = await import('./services/projectService.js');
    await projectService.migrateLegacyCollaboratorRoles();
    const { runDataMigrations } = await import('./db/migrations.js');
    await runDataMigrations();
  }
  await initEmail();
  if (shouldStartWorker) {
    startEmbeddingWorker();
  }

  const express = (await import('express')).default;
  const app = express();

  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  const cspScriptSources = ["'self'", 'https://static.cloudflareinsights.com'];
  const cspConnectSources = ["'self'", 'https://cloudflareinsights.com'];

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'script-src': cspScriptSources,
          'script-src-elem': cspScriptSources,
          'connect-src': cspConnectSources,
        },
      },
    })
  );
  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.nodeEnv === 'test' ? 10_000 : 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again later' },
  });

  const agentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many agent requests, please try again later' },
  });

  app.get('/health', async (_req, res) => {
    const checks: Record<string, string> = { service: 'ok' };

    try {
      if (mongoose.connection.readyState !== 1) {
        checks.mongodb = 'disconnected';
        res.status(503).json({ status: 'degraded', version: APP_VERSION, checks });
        return;
      }
      await mongoose.connection.db?.admin().ping();
      checks.mongodb = 'ok';
    } catch {
      checks.mongodb = 'error';
      res.status(503).json({ status: 'degraded', version: APP_VERSION, checks });
      return;
    }

    checks.email = getEmailStatus();
    res.json({ status: 'ok', service: 'qtask', version: APP_VERSION, checks });
  });

  app.use('/api/auth', authLimiter, authRouter);

  app.use('/api/tasks', requireAuth, tasksRouter);
  app.use('/api/projects', requireAuth, projectsRouter);
  app.use('/api/search', requireAuth, searchRouter);
  app.use('/api', requireAuth, agentLimiter, agentRouter);

  if (config.serveClient && config.nodeEnv === 'production') {
    const clientDist = path.resolve(__dirname, '../client/dist');
    app.use(express.static(clientDist));
    app.get(/^(?!\/api|\/health).*/, (_req, res, next) => {
      res.sendFile(path.join(clientDist, 'index.html'), (err) => {
        if (err) next();
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
