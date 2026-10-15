/**
 * The object storage a test that stores uploads should use: a LocalObjectStorage under `root` by
 * default, or - with STORAGE_BACKEND=kdb - a KdbObjectStorage on a private in-memory kdb-service
 * this helper starts, so the same feedback tests run against KDB attachments:
 *
 *   STORAGE_BACKEND=kdb node --import tsx --test tests/feedback.test.ts tests/feedback-vision-queue.test.ts
 *
 * Each calling file passes its own port (test files run in parallel processes).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import type { ObjectStorage } from '../../src/services/storage/types.ts';
import { CLIENT_MODULE, SERVICE_BIN, kdbUnavailable } from './kdbRelease.ts';

export interface TestObjectStorage {
  storage: ObjectStorage;
  backend: 'local' | 'kdb';
  stop(): Promise<void>;
}

export async function createTestObjectStorage(root: string, kdbPort: number): Promise<TestObjectStorage> {
  if (process.env.STORAGE_BACKEND !== 'kdb') {
    const { LocalObjectStorage } = await import('../../src/services/storage/local.ts');
    return { storage: new LocalObjectStorage(root), backend: 'local', stop: async () => undefined };
  }
  if (kdbUnavailable) throw new Error(`STORAGE_BACKEND=kdb: ${kdbUnavailable}`);
  process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
  const namespace = `qtaskstore/t${process.pid}`;
  const service: ChildProcess = spawn(
    SERVICE_BIN,
    [
      '--memory',
      '--namespace', namespace,
      '--peer-addr', '', '--stream-addr', '',
      '--sql-addr', `tcp://127.0.0.1:${kdbPort}?bind=true`,
      '--log-level', 'error',
    ],
    { stdio: 'ignore' }
  );
  service.unref();
  const kill = () => {
    if (!service.killed) service.kill('SIGKILL');
  };
  process.on('exit', kill);
  await waitForPort(kdbPort);
  const { KdbObjectStorage } = await import('../../src/services/storage/kdb.ts');
  const storage = new KdbObjectStorage({ addr: `tcp://127.0.0.1:${kdbPort}`, namespace });
  return {
    storage,
    backend: 'kdb',
    stop: async () => {
      await storage.close();
      kill();
    },
  };
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((done) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => done(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`kdb-service did not open port ${port}`);
}
