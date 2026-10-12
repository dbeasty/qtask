/**
 * Atomicity that does not depend on sharing a process.
 *
 * The store serialises writers inside one process with locks, and relies on the server's
 * conditional writes (replaceIf on a content hash) for everything beyond that. This runs
 * several real OS processes against one document and checks the two things a lock would get
 * wrong: no increment is lost, and exactly one process wins a "claim if unclaimed".
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const KDB_ROOT = process.env.KDB_ROOT ?? resolve(import.meta.dirname, '../../kdb');
const CLIENT_MODULE = process.env.KDB_CLIENT_MODULE ?? resolve(KDB_ROOT, 'packages/kdb-client/src/index.ts');
const SERVICE_BIN = process.env.KDB_SERVICE_BIN ?? resolve(KDB_ROOT, 'go/bin/kdb-service');
const PORT = Number(process.env.KDB_TEST_PORT_MULTIPROCESS ?? 7919);
const NS = 'qtaskmp/docs';
const skip = !existsSync(SERVICE_BIN) || !existsSync(CLIENT_MODULE) ? `kdb not available at ${KDB_ROOT}` : undefined;

import type { DataStore } from '../src/data/types.ts';

describe('KDB atomicity across processes', { skip }, () => {
  let service: ChildProcess;
  let store: DataStore;

  before(async () => {
    process.env.DATA_KDB = 'true';
    delete process.env.DATA_MONGO;
    process.env.DATA_KDB_PUSHDOWN = 'true';
    process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
    process.env.KDB_ADDR = `tcp://127.0.0.1:${PORT}`;
    process.env.KDB_NAMESPACE_PREFIX = NS;
    service = spawn(SERVICE_BIN, ['--memory', '--namespace', NS, '--sql-addr', `tcp://127.0.0.1:${PORT}?bind=true`, '--log-level', 'error'], { stdio: 'ignore' });
    await waitForPort(PORT);
    await import('../src/models/index.ts');
    const { KdbDataStore } = await import('../src/data/kdb/store.ts');
    store = new KdbDataStore();
    await store.connect();
  });

  after(async () => {
    await store?.disconnect();
    service?.kill('SIGKILL');
  });

  it('loses no increment and gives a claim to exactly one of several processes', async () => {
    const WORKERS = 4;
    const ROUNDS = 12;
    const tasks = store.collection('tasks');
    const doc = await tasks.create({ userId: 'mp-user', title: 'shared', percentComplete: 0 });

    const outputs = await Promise.all(
      Array.from({ length: WORKERS }, () => runWorker(String(doc._id), ROUNDS))
    );

    const claims = outputs.map((o) => o.claimed);
    const final = (await tasks.findById(doc._id as string))!;
    assert.equal(final.percentComplete, WORKERS * ROUNDS, 'an increment was lost between processes');
    assert.equal(claims.reduce((a, b) => a + b, 0), 1, `exactly one process may win the claim, got ${JSON.stringify(claims)}`);
    assert.match(String(final.description), /^claimed-by-\d+$/);
  });
});

function runWorker(docId: string, rounds: number): Promise<{ pid: number; claimed: number }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/kdbClaimWorker.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, WORKER_DOC_ID: docId, WORKER_ROUNDS: String(rounds) },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('WORKER_RESULT '));
      if (code !== 0 || !line) return fail(new Error(`worker exited ${code}: ${err.slice(0, 400)}`));
      done(JSON.parse(line.slice('WORKER_RESULT '.length)));
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((done) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => done(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`kdb-service did not open port ${port}`);
}
