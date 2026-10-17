/**
 * Entry point of the local backend (what the Mac app runs under its bundled Node).
 *
 * The regular config module reads the environment once, at import. So this file does the
 * environment work first (session secrets, KDB wiring, storage paths) and only then
 * imports the server. Do not add static imports of anything under ../ here.
 *
 * Inputs (set by the supervisor):
 *   QTASK_DEVICE_TOKEN   required, the per-launch secret
 *   QTASK_DATA_DIR       optional, defaults to ~/Library/Application Support/QTask
 *   KDB_ADDR             required, tcp://127.0.0.1:<port> of this launch's kdb-service
 *   KDB_CLIENT_MODULE    optional, path of the bundled @limidus/kdb-client
 */

import path from 'node:path';
import { loadOrCreateSecrets, ensureDataDirs } from './device.js';
import { resolveDataDir } from './config.js';

process.env.QTASK_LOCAL = '1';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'production';
// A device must never pick up a developer's or server's dotenv files.
process.env.QTASK_SKIP_DOTENV = 'true';
process.env.SERVE_CLIENT = 'false';
process.env.EMBEDDING_WORKER_ENABLED = 'false';
process.env.FEEDBACK_VISION_WORKER_ENABLED = 'false';
process.env.FEEDBACK_ENABLED = 'false';
process.env.MCP_OAUTH_ENABLED = 'false';
// Not Mongo, and not a mirror of anything: see resolveDataBackend.
delete process.env.DATA_MONGO;
delete process.env.DATA_SHADOW_WRITES;
delete process.env.DATA_SHADOW_READS;

const dataDir = resolveDataDir();
const paths = ensureDataDirs(dataDir);
const secrets = loadOrCreateSecrets(dataDir);
process.env.QTASK_DATA_DIR = dataDir;
process.env.JWT_SECRET = secrets.jwtSecret;
process.env.ADMIN_JWT_SECRET = secrets.adminJwtSecret;
process.env.MCP_OAUTH_JWT_SECRET = secrets.mcpOAuthJwtSecret;
process.env.STORAGE_BACKEND = 'local';
process.env.STORAGE_LOCAL_PATH = path.join(paths.uploadsDir);
process.env.KDB_NAMESPACE_PREFIX = process.env.KDB_NAMESPACE_PREFIX ?? 'qtask/docs';
// See KdbDataStore.connect: the first request after opening a large store can be slow.
process.env.KDB_REQUEST_TIMEOUT_MS = process.env.KDB_REQUEST_TIMEOUT_MS ?? String(15 * 60 * 1000);

if (!process.env.KDB_ADDR) {
  console.error('KDB_ADDR is required: the supervisor starts kdb-service and passes its address');
  process.exit(2);
}

const { startLocalServer } = await import('./server.js');
await startLocalServer().catch((error) => {
  console.error('Failed to start the local server:', error);
  process.exit(1);
});
