/**
 * Runs the application's own test suite on KDB instead of MongoDB.
 *
 *   QTASK_TEST_BACKEND=kdb node --import tsx --import ./tests/helpers/useKdbBackend.ts --test tests/*.test.ts
 *
 * (or `npm run test:kdb`). Preloaded into every test process, it starts a private
 * `kdb-service` for that process, points the app at it through the same environment
 * variables a deployment uses, and stops it on exit. No test file changes: each already
 * boots the real app with `createApp({ connect: true })`, so they exercise the real
 * routes, services, auth and workers on the real server - which is the point. A stub
 * would agree with whatever it was written to agree with.
 *
 * A failure here is one of three things, and worth telling apart:
 *  - the test seeds data through Mongoose directly (the app then reads an empty KDB) -
 *    code still coupled to the old driver, to be moved onto the data layer;
 *  - a real behavioural difference between the backends - a bug to fix or a parity
 *    case to add to the conformance suite;
 *  - a performance cliff, since KDB scans where Mongo indexes.
 *
 * QTASK_TEST_BACKEND=shadow is the migration's Stage 3 as a test run: MongoDB stays primary
 * and answers everything, while KDB mirrors every write and is asked every read, with
 * disagreements reported (DATA_SHADOW_WRITES + DATA_SHADOW_READS). Each test file prints one
 * `QTASK_SHADOW_REPORT {json}` line when it finishes; `npm run test:shadow` sums them. The
 * suite passing says the app works; a zero `diverged` says KDB gave the same answers to every
 * question the app asked along the way.
 *
 * Does nothing unless QTASK_TEST_BACKEND is `kdb` or `shadow`, so the default `npm test` is
 * unchanged.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { after } from 'node:test';
import { installMongooseOnDataLayer } from './mongooseOnDataLayer.ts';

// The test runner's parent process receives the same --import flags as its children but runs
// no tests; it must not start a server (nor wait on one).
const MODE = process.env.QTASK_TEST_BACKEND;
if ((MODE === 'kdb' || MODE === 'shadow') && !process.execArgv.includes('--test')) {
  const KDB_ROOT = process.env.KDB_ROOT ?? resolve(import.meta.dirname, '../../../kdb');
  const SERVICE_BIN = process.env.KDB_SERVICE_BIN ?? resolve(KDB_ROOT, 'go/bin/kdb-service');
  const CLIENT_MODULE = process.env.KDB_CLIENT_MODULE ?? resolve(KDB_ROOT, 'packages/kdb-client/src/index.ts');
  if (!existsSync(SERVICE_BIN)) throw new Error(`QTASK_TEST_BACKEND=${MODE}: no kdb-service at ${SERVICE_BIN} (set KDB_ROOT or KDB_SERVICE_BIN)`);
  if (!existsSync(CLIENT_MODULE)) throw new Error(`QTASK_TEST_BACKEND=${MODE}: no @kdb/client at ${CLIENT_MODULE} (set KDB_CLIENT_MODULE)`);

  const port = await freePort();
  const namespace = `qtask/e2e${process.pid}`;
  const service = spawn(
    SERVICE_BIN,
    [
      '--memory',
      '--namespace', namespace,
      // v0.6.2 binds these by default; a second instance on the host would not start.
      '--peer-addr', '',
      '--stream-addr', '',
      '--sql-addr', `tcp://127.0.0.1:${port}?bind=true`,
      '--expire-field', '_expireAt',
      '--expire-interval', '1s',
      '--log-level', 'error',
    ],
    { stdio: 'ignore' }
  );
  // Without this the child keeps the event loop alive and no test process ever exits.
  service.unref();
  const stop = () => {
    // SIGKILL: a SIGTERM makes kdb-service drain for up to 30s, and this one holds nothing.
    if (!service.killed) service.kill('SIGKILL');
  };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });
  process.on('SIGTERM', () => { stop(); process.exit(143); });
  service.on('exit', (code) => {
    if (code !== null && code !== 0 && !service.killed) console.error(`kdb-service exited with ${code}`);
  });
  await waitForPort(port);

  if (MODE === 'kdb') {
    // A test that reaches for Mongoose directly has no connected Mongo to talk to. By default
    // Mongoose queues the call for 10s before failing; fail it at once, with a message that
    // names the cause, so the run stays fast and the coupling is obvious.
    mongoose.set('bufferCommands', false);
  }
  // ...and the model calls tests use to arrange and check data go to the data layer instead -
  // in shadow mode too, so seeded fixtures are mirrored like any other write.
  installMongooseOnDataLayer({ mongoConnected: MODE === 'shadow' });

  // Test files tear down Mongoose, not the data store, so the app's KDB connection would hold
  // the process open for ever. A root-level hook runs once the file's tests are done.
  after(async () => {
    const { disconnectData, getDataStore } = await import('../../src/data/index.js');
    if (MODE === 'shadow') {
      // disconnect() drains the queue of mirrored writes and queued comparisons, so the counters
      // read afterwards are those of a settled system. The store object outlives the connection.
      let store: { stats?: () => unknown; readStats?: () => unknown } = {};
      try {
        store = getDataStore() as unknown as typeof store;
      } catch {
        // A file that never connected (a pure unit test) has nothing to report.
        return;
      }
      await disconnectData();
      console.log(`QTASK_SHADOW_REPORT ${JSON.stringify({ pid: process.pid, writes: store.stats?.(), reads: store.readStats?.() })}`);
      return;
    }
    await disconnectData();
  });

  if (MODE === 'kdb') {
    process.env.DATA_KDB = 'true';
    delete process.env.DATA_MONGO;
  } else {
    delete process.env.DATA_KDB;
    process.env.DATA_SHADOW_WRITES = 'true';
    process.env.DATA_SHADOW_READS = 'true';
  }
  process.env.DATA_KDB_PUSHDOWN = process.env.QTASK_TEST_KDB_PUSHDOWN ?? 'true';
  process.env.KDB_ADDR = `tcp://127.0.0.1:${port}`;
  process.env.KDB_NAMESPACE_PREFIX = namespace;
  process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
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
