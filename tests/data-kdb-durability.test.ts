/**
 * What `--durability sync` promises, checked the only way that means anything: write through
 * the real store to a real on-disk kdb-service, kill it without warning, start it again on the
 * same data directory, and look. Every write that was acknowledged must be there; every delete
 * must have stuck; an expired document must stay expired.
 *
 * This is the property a migration from MongoDB relies on and that no in-memory test can show.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const KDB_ROOT = process.env.KDB_ROOT ?? resolve(import.meta.dirname, '../../kdb');
const CLIENT_MODULE = process.env.KDB_CLIENT_MODULE ?? resolve(KDB_ROOT, 'packages/kdb-client/src/index.ts');
const SERVICE_BIN = process.env.KDB_SERVICE_BIN ?? resolve(KDB_ROOT, 'go/bin/kdb-service');
const PORT = Number(process.env.KDB_TEST_PORT_DURABILITY ?? 7918);
const NS = 'qtaskdur/docs';
const skip = !existsSync(SERVICE_BIN) || !existsSync(CLIENT_MODULE) ? `kdb not available at ${KDB_ROOT}` : undefined;

import type { DataStore } from '../src/data/types.ts';

describe('KDB durability across a hard kill', { skip }, () => {
  let dataDir: string;
  let service: ChildProcess | undefined;
  const stores: DataStore[] = [];

  const start = async () => {
    service = spawn(
      SERVICE_BIN,
      [
        '--data-dir', dataDir,
        '--namespace', NS,
        '--sql-addr', `tcp://127.0.0.1:${PORT}?bind=true`,
        '--peer-addr', '', '--stream-addr', '',
        '--durability', 'sync',
        '--expire-field', '_expireAt',
        '--expire-interval', '500ms',
        '--log-level', 'error',
      ],
      { stdio: 'ignore' }
    );
    await waitForPort(PORT);
  };

  const hardKill = async () => {
    const exited = new Promise<void>((done) => service!.once('exit', () => done()));
    service!.kill('SIGKILL'); // no drain, no flush, no goodbye
    await exited;
    service = undefined;
  };

  /** A fresh store over a fresh connection, as the app has after its database restarts. */
  const openStore = async (): Promise<DataStore> => {
    const { KdbDataStore } = await import('../src/data/kdb/store.ts');
    const store = new KdbDataStore();
    await store.connect();
    stores.push(store);
    return store;
  };

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'qtask-kdb-durability-'));
    process.env.DATA_KDB = 'true';
    delete process.env.DATA_MONGO;
    process.env.DATA_KDB_PUSHDOWN = 'true';
    process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
    process.env.KDB_ADDR = `tcp://127.0.0.1:${PORT}`;
    process.env.KDB_NAMESPACE_PREFIX = NS;
    await import('../src/models/index.ts');
    await start();
  });

  after(async () => {
    for (const store of stores) await store.disconnect().catch(() => undefined);
    service?.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps every acknowledged create, update and delete after kill -9', async () => {
    const store = await openStore();
    const tasks = store.collection('tasks');

    // A concurrent burst: all acknowledged before the kill, so all must survive it.
    const created = await Promise.all(
      Array.from({ length: 150 }, (_, i) => tasks.create({ userId: 'dur-user', title: `burst-${i}`, status: 'todo' }))
    );
    const keep = created[10]!;
    const edit = created[20]!;
    const drop = created[30]!;
    await tasks.updateOne({ _id: edit._id }, { $set: { status: 'done', title: 'edited' } });
    await tasks.deleteOne({ _id: drop._id });

    await hardKill();
    await start();
    const after = await openStore();
    const reread = after.collection('tasks');

    assert.equal(await reread.countDocuments({ userId: 'dur-user' }), 149, 'every acknowledged create but the deleted one');
    assert.equal((await reread.findById(keep._id as string))?.title, 'burst-10');
    const edited = await reread.findById(edit._id as string);
    assert.equal(edited?.status, 'done');
    assert.equal(edited?.title, 'edited');
    assert.equal(await reread.findById(drop._id as string), null, 'a delete must not come back');
  });

  it('survives a second kill straight after restart, with writes in between', async () => {
    const store = await openStore();
    const users = store.collection('users');
    await users.create({ email: 'second-kill@example.com', displayName: 'S', passwordHash: 'x' });
    await hardKill();
    await start();
    const again = await openStore();
    assert.ok(await again.collection('users').findOne({ email: 'second-kill@example.com' }));
    // ...and the unique constraint still holds on the recovered data.
    await assert.rejects(
      again.collection('users').create({ email: 'second-kill@example.com', displayName: 'T', passwordHash: 'x' }),
      (error: { code?: number }) => error.code === 11000
    );
  });

  it('keeps expiring documents after a restart', async () => {
    const store = await openStore();
    const codes = store.collection('userOAuthAuthCodes');
    await codes.create({ codeHash: 'soon', userId: 'u1', expiresAt: new Date(Date.now() + 2_500) });
    await codes.create({ codeHash: 'later', userId: 'u1', expiresAt: new Date(Date.now() + 3_600_000) });

    await hardKill();
    await start();
    const after = await openStore();
    const reread = after.collection('userOAuthAuthCodes');
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 4_000));

    assert.equal(await reread.findOne({ codeHash: 'soon' }), null, 'an expired code must not outlive the restart');
    assert.ok(await reread.findOne({ codeHash: 'later' }));
  });
});

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
