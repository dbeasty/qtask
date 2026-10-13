/**
 * Atomicity that does not depend on sharing a process.
 *
 * The store serialises writers inside one process with locks, and relies on the server's
 * conditional writes (replaceIf on a content hash) for everything beyond that. This runs
 * several real OS processes against one document and checks the two things a lock would get
 * wrong: no increment is lost, and exactly one process wins a "claim if unclaimed".
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_MODULE, SERVICE_BIN, kdbUnavailable } from './helpers/kdbRelease.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const PORT = Number(process.env.KDB_TEST_PORT_MULTIPROCESS ?? 7919);
const NS = 'qtaskmp/docs';
const skip = kdbUnavailable;

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

  it('lets exactly one of several processes register the same email, the rest getting a duplicate key', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => runWorker('', 0, { WORKER_MODE: 'create-user', WORKER_EMAIL: 'mp-race@example.com' }))
    );
    const results = outcomes.map((o) => o.outcome as string);
    assert.deepEqual(
      results.filter((r) => r !== 'created' && r !== 'duplicate'),
      [],
      `unexpected outcomes: ${JSON.stringify(results)}`
    );
    assert.equal(results.filter((r) => r === 'created').length, 1, `exactly one process may create it: ${JSON.stringify(results)}`);
    assert.equal(await store.collection('users').countDocuments({ email: 'mp-race@example.com' }), 1);
  });

  it('lets exactly one of several processes link the same external login', async (t) => {
    if (!(await serverHasMultikeyUnique())) return t.skip('this kdb-service treats an array as one value under a unique constraint (multikey arrives after 0.7.1)');
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => runWorker('', 0, { WORKER_MODE: 'link-login', WORKER_LOGIN: 'g-race' }))
    );
    const results = outcomes.map((o) => o.outcome as string);
    assert.deepEqual(results.filter((r) => r !== 'created' && r !== 'duplicate'), [], `unexpected outcomes: ${JSON.stringify(results)}`);
    assert.equal(results.filter((r) => r === 'created').length, 1, `exactly one process may link it: ${JSON.stringify(results)}`);
    assert.equal(await store.collection('users').countDocuments({ 'identityProviders.providerUserId': 'g-race' }), 1);
  });

  it('holds a linked login per element: overlap refused, own relink fine, an unlinked login is free', async (t) => {
    if (!(await serverHasMultikeyUnique())) return t.skip('this kdb-service treats an array as one value under a unique constraint (multikey arrives after 0.7.1)');
    const users = store.collection('users');
    const login = (provider: string, providerUserId: string) => ({ provider, providerUserId });
    const holder = await users.create({
      email: 'holder@example.com', displayName: 'H', passwordHash: 'x',
      identityProviders: [login('google', 'g-1'), login('microsoft', 'm-1')],
    });
    // A different list sharing one login: different as a whole, so only the server's per-element
    // constraint refuses it.
    await assert.rejects(
      users.create({ email: 'other@example.com', displayName: 'O', passwordHash: 'x', identityProviders: [login('microsoft', 'm-9'), login('google', 'g-1')] }),
      (e: { code?: number }) => e.code === 11000
    );
    // The same id under another provider is another login.
    await users.create({ email: 'third@example.com', displayName: 'T', passwordHash: 'x', identityProviders: [login('microsoft', 'g-1')] });
    // The holder rewrites its own list, keeping one login and dropping the other.
    await users.updateOne({ _id: holder._id }, { $set: { identityProviders: [login('google', 'g-1')] } });
    await users.create({ email: 'fourth@example.com', displayName: 'F', passwordHash: 'x', identityProviders: [login('microsoft', 'm-1')] });
    // Accounts with no linked login claim nothing.
    await users.create({ email: 'none-1@example.com', displayName: 'N', passwordHash: 'x' });
    await users.create({ email: 'none-2@example.com', displayName: 'N', passwordHash: 'x', identityProviders: [] });
    // ...and the synthetic key never reaches the caller.
    const read = (await users.findById(holder._id as string))!;
    assert.deepEqual(Object.keys(read).filter((k) => k.startsWith('_u_')), []);
  });

  it('scopes a constraint to its collection: a repeated clientId is fine on codes, not on clients', async () => {
    const clients = store.collection('mcpOAuthClients');
    const codes = store.collection('mcpOAuthAuthorizationCodes');
    await clients.create({ clientId: 'c1', name: 'one', source: 'dcr' });
    await assert.rejects(clients.create({ clientId: 'c1', name: 'two', source: 'dcr' }), (e: { code?: number }) => e.code === 11000);
    // Authorization codes carry the same clientId many times over, and must be allowed to.
    for (const hash of ['h1', 'h2', 'h3']) {
      await codes.create({
        codeHash: hash, clientId: 'c1', userId: 'u', redirectUri: 'https://x', scope: 's', codeChallenge: 'c',
        codeChallengeMethod: 'S256', resource: 'r', expiresAt: new Date(Date.now() + 60_000),
      });
    }
    assert.equal(await codes.countDocuments({ clientId: 'c1' }), 3);
  });
});

/** Whether the server holds each array element as its own unique claim. Asked of the server
 *  itself, on a field no collection uses, rather than read off a version number. */
let multikey: Promise<boolean> | undefined;
function serverHasMultikeyUnique(): Promise<boolean> {
  return (multikey ??= probeMultikeyUnique());
}

async function probeMultikeyUnique(): Promise<boolean> {
  const raw = (await import(CLIENT_MODULE)) as {
    connect(a: string, t: string): Promise<{
      exec(ns: string, sql: string): Promise<unknown>;
      replace(ns: string, id: string, body: object): Promise<unknown>;
      close(): Promise<void>;
    }>;
  };
  const client = await raw.connect(process.env.KDB_ADDR!, '');
  try {
    await client.exec(NS, 'CREATE UNIQUE INDEX qtask_probe_multikey ON docs (_probe_multikey)').catch(() => undefined);
    await client.replace(NS, randomUUID(), { _probe_multikey: ['x', 'shared'] });
    try {
      await client.replace(NS, randomUUID(), { _probe_multikey: ['shared', 'y'] });
      return false;
    } catch (error) {
      if ((error as { code?: string }).code === 'UNIQUE_VIOLATION') return true;
      throw error;
    }
  } finally {
    await client.close();
  }
}

function runWorker(docId: string, rounds: number, extra: Record<string, string> = {}): Promise<any> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/kdbClaimWorker.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, WORKER_DOC_ID: docId, WORKER_ROUNDS: String(rounds), ...extra },
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
