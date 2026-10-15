/**
 * The backfill/verify tool, run as the operator would run it: a subprocess against a
 * real mongod and a real kdb-service. Seeds MongoDB, copies, checks the check -
 * including that verify actually fails when the copy is wrong, since a verifier that
 * can only say "ok" is not one.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_MODULE, SERVICE_BIN, kdbUnavailable } from './helpers/kdbRelease.ts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const PORT = Number(process.env.KDB_TEST_PORT_MIGRATE ?? 7814);
const skip = kdbUnavailable;

describe('migrate-mongo-to-kdb', { skip }, () => {
  let mongod: MongoMemoryServer;
  let service: ChildProcess;
  let env: NodeJS.ProcessEnv;

  // Async on purpose: a synchronous spawn freezes this process's event loop, and the
  // embedded mongod then stops answering the tool it is being asked to read from.
  const run = (...args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/scripts/migrate-mongo-to-kdb.ts', ...args], {
        env, cwd: resolve(import.meta.dirname, '..'),
        // A run that never finishes must not outlive the test: the test runner's timeout
        // cancels the test, but a live child keeps this file's process (and npm test) up.
        timeout: 100_000, killSignal: 'SIGKILL',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (status) => done({ status, stdout, stderr }));
    });

  before(async () => {
    mongod = await MongoMemoryServer.create();
    service = spawn(
      SERVICE_BIN,
      ['--memory', '--namespace', 'qtaskmig/docs', '--peer-addr', '', '--stream-addr', '', '--sql-addr', `tcp://127.0.0.1:${PORT}?bind=true`, '--log-level', 'error'],
      { stdio: 'ignore' }
    );
    await waitForPort(PORT);
    env = {
      ...process.env,
      MONGODB_URI: `${mongod.getUri()}qtask`,
      KDB_ADDR: `tcp://127.0.0.1:${PORT}`,
      KDB_CLIENT_MODULE: CLIENT_MODULE,
      KDB_NAMESPACE_PREFIX: 'qtaskmig/docs',
    };

    process.env.MONGODB_URI = env.MONGODB_URI;
    await import('../src/models/index.ts');
    await mongoose.connect(env.MONGODB_URI!, { family: 4 });
    const { MongoDataStore } = await import('../src/data/mongo/store.ts');
    const mongo = new MongoDataStore();
    const users = mongo.collection('users');
    const tasks = mongo.collection('tasks');
    const owner = await users.create({ email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x' });
    for (let i = 0; i < 1200; i++) {
      await tasks.create({ userId: owner._id, title: `Task ${i}`, status: i % 3 ? 'todo' : 'done', tags: ['t' + (i % 5)], steps: [{ text: 'a' }] });
    }
  });

  after(async () => {
    await mongoose.disconnect();
    service?.kill();
    await mongod?.stop();
  });

  it('counts reads only MongoDB and flags the scan cap', async () => {
    const result = await run('counts');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1200\s+tasks/);
    assert.match(result.stdout, /1201\s+TOTAL/);
    assert.doesNotMatch(result.stdout, /PAST THE CAP/);
  });

  it('verify fails before the copy exists', async () => {
    const result = await run('verify', '--collection=tasks');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /DIFFERS .*tasks.*missing=1200/);
  });

  it('a dry run writes nothing', async () => {
    const result = await run('backfill', '--dry-run');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would copy\s+1200\s+tasks/);
    assert.match((await run('verify', '--collection=tasks')).stdout, /missing=1200/);
  });

  it('backfills, and verify then agrees', async () => {
    const copy = await run('backfill');
    assert.equal(copy.status, 0, copy.stderr);
    assert.match(copy.stdout, /copied\s+1200\s+tasks/);
    const check = await run('verify');
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /ok\s+tasks\s+mongo=1200 kdb=1200 missing=0 differing=0 extra=0/);
    assert.match(check.stdout, /ok\s+users\s+mongo=1 kdb=1/);
  });

  it('is idempotent', async () => {
    assert.equal((await run('backfill')).status, 0);
    assert.equal((await run('verify')).status, 0);
  });

  it('verify reports drift by field name, never by value', async () => {
    await mongoose.connection.collection('tasks').updateOne({ title: 'Task 7' }, { $set: { title: 'SECRET-TITLE-VALUE' } });
    const check = await run('verify', '--collection=tasks');
    assert.equal(check.status, 1);
    assert.match(check.stdout, /differing=1/);
    assert.match(check.stdout, /fields=\[title\]/);
    assert.doesNotMatch(check.stdout, /SECRET-TITLE-VALUE/);
    // Re-running the backfill repairs it.
    assert.equal((await run('backfill', '--collection=tasks')).status, 0);
    assert.equal((await run('verify', '--collection=tasks')).status, 0);
  });

  it('verify reports a surplus in KDB', async () => {
    await mongoose.connection.collection('tasks').deleteOne({ title: 'Task 8' });
    const check = await run('verify', '--collection=tasks');
    assert.equal(check.status, 1);
    assert.match(check.stdout, /extra=1/);
  });
});

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
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
