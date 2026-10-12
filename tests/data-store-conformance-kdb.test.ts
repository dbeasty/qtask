/**
 * The conformance spec against KDB — the same assertions the Mongo file runs.
 *
 * Boots a real kdb-service in memory mode, the way the Mongo file boots a real
 * mongod. A stub speaking the wire protocol would be faster and would prove nothing:
 * the point of the suite is that the two backends agree, and a stub agrees with
 * whatever it was written to agree with.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { CLIENT_MODULE, SERVICE_BIN, kdbUnavailable } from './helpers/kdbRelease.ts';
import { runDataStoreConformance } from './helpers/dataStoreSpec.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

// Defaults assume kdb is checked out beside qtask, which is how it is developed.
const PORT = Number(process.env.KDB_TEST_PORT ?? 7811);

let service: ChildProcess | undefined;

function unavailable(): string | undefined {
  return kdbUnavailable;
}

runDataStoreConformance({
  name: 'kdb',
  skip: unavailable(),
  async start() {
    process.env.DATA_KDB = 'true';
    delete process.env.DATA_MONGO;
    process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
    process.env.KDB_ADDR = `tcp://127.0.0.1:${PORT}`;
    process.env.KDB_NAMESPACE_PREFIX = 'qtaskconf/docs';

    service = spawn(
      SERVICE_BIN,
      [
        '--memory',
        '--namespace',
        'qtaskconf/docs',
        '--peer-addr', '', '--stream-addr', '', '--sql-addr',
        `tcp://127.0.0.1:${PORT}?bind=true`,
        '--log-level',
        'error',
      ],
      { stdio: 'ignore' }
    );
    await waitForPort(PORT);

    await import('../src/models/index.ts');
    const { KdbDataStore } = await import('../src/data/kdb/store.ts');
    const store = new KdbDataStore();
    await store.connect();
    return store;
  },
  async stop() {
    service?.kill();
  },
});

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`kdb-service did not open port ${port}`);
}
