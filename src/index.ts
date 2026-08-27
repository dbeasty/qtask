import { config } from './config/index.js';
import { createApp } from './app.js';
import { disconnectDb } from './db/connection.js';
import { stopEmbeddingWorker } from './services/embeddingQueue.js';
import { stopFeedbackVisionWorker } from './services/feedbackVisionQueue.js';
import { stagingService } from './services/stagingService.js';
import { mcpSessionService } from './services/mcpSessionService.js';

async function main() {
  const app = await createApp();
  stagingService.startSweep();
  mcpSessionService.startSweep();

  const server = app.listen(config.port, () => {
    console.log(`QTask API listening on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    console.log('Shutting down...');
    stopEmbeddingWorker();
    stopFeedbackVisionWorker();
    stagingService.stopSweep();
    mcpSessionService.stopSweep();
    server.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
