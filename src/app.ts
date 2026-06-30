import { Router } from 'express';
import { connectDb } from './db/connection.js';
import { projectsRouter } from './routes/projects.js';
import { tasksRouter } from './routes/tasks.js';
import { chatRouter } from './routes/chat.js';
import { errorHandler, notFoundHandler } from './middleware/index.js';
import { startEmbeddingWorker } from './services/embeddingQueue.js';

export async function createApp() {
  await connectDb();
  startEmbeddingWorker();

  const express = (await import('express')).default;
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'qtask' });
  });

  app.use('/api/tasks', tasksRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api', chatRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
