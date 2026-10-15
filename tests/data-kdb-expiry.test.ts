/**
 * Mongo's TTL indexes have a KDB counterpart: the store stamps `_expireAt` on
 * collections whose schema declares `expireAfterSeconds`, and `kdb-service
 * --expire-field _expireAt` sweeps them. Collections without a TTL index - invites,
 * which are marked `expired` rather than removed - must be left alone.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_MODULE, SERVICE_BIN, kdbUnavailable } from './helpers/kdbRelease.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const PORT = Number(process.env.KDB_TEST_PORT_EXPIRY ?? 7816);
const skip = kdbUnavailable;

import { ttlSpec, EXPIRE_FIELD } from '../src/data/kdb/schema.ts';
import type { DataStore } from '../src/data/types.ts';

describe('ttlSpec', () => {
  it('finds the TTL path on collections that declare one, and only those', async () => {
    const { default: mongoose } = await import('mongoose');
    await import('../src/models/index.ts');
    assert.deepEqual(ttlSpec(mongoose.models.UserOAuthAuthCode.schema), { path: 'expiresAt', graceMs: 0 });
    assert.deepEqual(ttlSpec(mongoose.models.McpOAuthRefreshToken.schema), { path: 'expiresAt', graceMs: 0 });
    assert.equal(ttlSpec(mongoose.models.Invite.schema), null);
    assert.equal(ttlSpec(mongoose.models.Task.schema), null);
  });
});

describe('server-side expiry', { skip }, () => {
  let service: ChildProcess;
  let store: DataStore;

  before(async () => {
    process.env.DATA_KDB = 'true';
    delete process.env.DATA_MONGO;
    process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
    process.env.KDB_ADDR = `tcp://127.0.0.1:${PORT}`;
    process.env.KDB_NAMESPACE_PREFIX = 'qtaskttl/docs';
    service = spawn(
      SERVICE_BIN,
      ['--memory', '--namespace', 'qtaskttl/docs', '--peer-addr', '', '--stream-addr', '', '--sql-addr', `tcp://127.0.0.1:${PORT}?bind=true`,
        '--log-level', 'error', '--expire-field', EXPIRE_FIELD, '--expire-interval', '500ms'],
      { stdio: 'ignore' }
    );
    await waitForPort(PORT);
    await import('../src/models/index.ts');
    const { KdbDataStore } = await import('../src/data/kdb/store.ts');
    store = new KdbDataStore();
    await store.connect();
  });

  after(async () => {
    await store?.disconnect();
    service?.kill();
  });

  it('removes an expired code, keeps a live one, never exposes the bookkeeping field', async () => {
    const codes = store.collection('userOAuthAuthCodes');
    await codes.create({ codeHash: 'soon', userId: 'u1', expiresAt: new Date(Date.now() + 800) });
    await codes.create({ codeHash: 'later', userId: 'u1', expiresAt: new Date(Date.now() + 3_600_000) });

    const live = await codes.findOne({ codeHash: 'later' });
    assert.ok(live);
    assert.equal(EXPIRE_FIELD in live, false);
    assert.ok(await codes.findOne({ codeHash: 'soon' }));

    await new Promise((r) => setTimeout(r, 2_500));
    assert.equal(await codes.findOne({ codeHash: 'soon' }), null);
    assert.ok(await codes.findOne({ codeHash: 'later' }));
  });

  it('leaves an invite alone after its expiresAt passes', async () => {
    const invites = store.collection('invites');
    await invites.create({
      projectId: 'p1', inviterUserId: 'u1', inviteeEmail: 'a@b.co', role: 'viewer', token: 'tok',
      expiresAt: new Date(Date.now() - 60_000),
    });
    await new Promise((r) => setTimeout(r, 1_500));
    assert.ok(await invites.findOne({ token: 'tok' }));
  });

  it('moves the deadline when the document is rewritten', async () => {
    const codes = store.collection('userOAuthAuthCodes');
    await codes.create({ codeHash: 'extended', userId: 'u1', expiresAt: new Date(Date.now() + 700) });
    await codes.updateOne({ codeHash: 'extended' }, { $set: { expiresAt: new Date(Date.now() + 3_600_000) } });
    await new Promise((r) => setTimeout(r, 2_000));
    assert.ok(await codes.findOne({ codeHash: 'extended' }));
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
