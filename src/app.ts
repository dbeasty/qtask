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
import { invitesRouter, invitePreviewHandler } from './routes/invites.js';
import { notificationsRouter } from './routes/notifications.js';
import { feedbackRouter } from './routes/feedback.js';
import { mcpKeysRouter } from './routes/mcpKeys.js';
import { mcpOAuthClientsRouter } from './routes/mcpOAuthClients.js';
import { mcpRouter } from './routes/mcp.js';
import { oauthRouter } from './routes/oauth.js';
import { mountWellKnownRoutes } from './routes/wellKnown.js';
import { errorHandler, notFoundHandler } from './middleware/index.js';
import { readOnlyMiddleware, getDeploymentHealthPayload } from './middleware/readOnly.js';
import { requireAuth } from './middleware/auth.js';
import { startEmbeddingWorker } from './services/embeddingQueue.js';
import { startFeedbackVisionWorker } from './services/feedbackVisionQueue.js';
import { config, getHealthFeaturesPayload } from './config/index.js';
import { initEmail, getEmailStatus } from './services/emailService.js';
import { APP_VERSION } from './version.js';
import { fetchAiStackVersion } from './services/aiStackVersion.js';

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
  if (shouldStartWorker && config.embeddingWorkerEnabled && process.env.EMBEDDING_WORKER_ENABLED !== 'false') {
    startEmbeddingWorker();
  }
  if (shouldStartWorker && config.feedbackVisionWorkerEnabled) {
    startFeedbackVisionWorker();
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
  app.use(express.urlencoded({ extended: false }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.nodeEnv === 'test' ? 10_000 : 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again later' },
  });

  app.get('/health', async (_req, res) => {
    const checks: Record<string, string> = { service: 'ok' };

    try {
      if (mongoose.connection.readyState !== 1) {
        checks.mongodb = 'disconnected';
        res.status(503).json({
          status: 'degraded',
          version: APP_VERSION,
          checks,
          deployment: getDeploymentHealthPayload(),
        });
        return;
      }
      await mongoose.connection.db?.admin().ping();
      checks.mongodb = 'ok';
    } catch {
      checks.mongodb = 'error';
      res.status(503).json({
        status: 'degraded',
        version: APP_VERSION,
        checks,
        deployment: getDeploymentHealthPayload(),
      });
      return;
    }

    checks.email = getEmailStatus();
    const aiVersion = await fetchAiStackVersion();
    const deployment = getDeploymentHealthPayload();
    res.json({
      status: 'ok',
      service: 'qtask',
      version: APP_VERSION,
      aiVersion,
      checks,
      features: getHealthFeaturesPayload(),
      ...(deployment.readOnly || deployment.phase !== 'normal' ? { deployment } : {}),
    });
  });

  app.use(readOnlyMiddleware);

  mountWellKnownRoutes(app);

  app.use('/oauth', authLimiter, oauthRouter);

  app.use('/api/auth', authLimiter, authRouter);

  app.get('/api/invites/preview/:token', authLimiter, invitePreviewHandler);

  app.use('/api/tasks', requireAuth, tasksRouter);
  app.use('/api/projects', requireAuth, projectsRouter);
  app.use('/api/invites', requireAuth, invitesRouter);
  app.use('/api/notifications', requireAuth, notificationsRouter);
  app.use('/api/feedback', requireAuth, feedbackRouter);
  app.use('/api/mcp-keys', requireAuth, mcpKeysRouter);
  app.use('/api/mcp-oauth-clients', requireAuth, mcpOAuthClientsRouter);
  app.use('/api/mcp', mcpRouter);
  app.use('/api/search', requireAuth, searchRouter);
  app.use('/api', requireAuth, agentRouter);

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
