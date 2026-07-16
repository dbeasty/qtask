import { config } from './config/index.js';
import { createApp } from './app.js';
import { disconnectDb } from './db/connection.js';
import { stopEmbeddingWorker } from './services/embeddingQueue.js';
import { stagingService } from './services/stagingService.js';

async function main() {
  const app = await createApp();
  stagingService.startSweep();

  const server = app.listen(config.port, () => {
    console.log(`QTask API listening on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    console.log('Shutting down...');
    stopEmbeddingWorker();
    stagingService.stopSweep();
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
