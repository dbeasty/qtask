import { config } from '../config/index.js';
import { disconnectDb } from '../db/connection.js';
import { createAdminApp } from './app.js';

async function main() {
  const app = await createAdminApp();
  const server = app.listen(config.admin.port, config.admin.host, () => {
    console.log(`QTask admin listening on http://${config.admin.host}:${config.admin.port}`);
  });

  const shutdown = async () => {
    server.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start admin server:', error);
  process.exit(1);
});
