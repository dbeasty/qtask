/**
 * kdb-service v0.6.2 truncates non-indexed SQL scans at 10,000 documents without
 * saying so (blocker B1 in docs/KDB_MIGRATION.md). The store must therefore refuse to
 * scan a namespace that large, while keyed operations - which do not scan - keep
 * working. This runs against a real server loaded past the cap.
 *
 * If the server is fixed, the first test notices and skips the rest: that is the
 * signal to retire the guard (KDB_SERVER_ROW_CAP=0), not a failure.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_MODULE, SERVICE_BIN, kdbUnavailable } from './helpers/kdbRelease.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const PORT = Number(process.env.KDB_TEST_PORT_CAP ?? 7817);
const NS = 'qtaskcap/docs';
const LOADED = 10_050;
const BULK = 'x'.repeat(1_800);
const skip = kdbUnavailable;

import { toDocumentUuid } from '../src/data/kdb/ids.ts';
import type { DataStore } from '../src/data/types.ts';

describe('KDB scan cap', { skip }, () => {
  let service: ChildProcess;
  let store: DataStore;
  let serverTruncates = true;

  const objectId = (n: number) => '6a' + n.toString(16).padStart(22, '0');

  before(async () => {
    process.env.DATA_KDB = 'true';
    delete process.env.DATA_MONGO;
    delete process.env.KDB_SERVER_ROW_CAP;
    // Pushdown is what lets a selective query ask for its matches instead of the whole
    // collection, which a fixed server would (rightly) refuse to return past MaxRows.
    process.env.DATA_KDB_PUSHDOWN = 'true';
    process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
    process.env.KDB_ADDR = `tcp://127.0.0.1:${PORT}`;
    process.env.KDB_NAMESPACE_PREFIX = NS;
    service = spawn(
      SERVICE_BIN,
      ['--memory', '--namespace', NS, '--peer-addr', '', '--stream-addr', '', '--sql-addr', `tcp://127.0.0.1:${PORT}?bind=true`, '--log-level', 'error'],
      { stdio: 'ignore' }
    );
    await waitForPort(PORT);

    const raw = (await import(CLIENT_MODULE)) as { connect(addr: string, token: string): Promise<{
      upsert(ns: string, id: string, body: unknown): Promise<string>;
      queryRaw(ns: string, sql: string): Promise<{ rows: string[][] }>;
      close(): Promise<void>;
    }> };
    const client = await raw.connect(process.env.KDB_ADDR!, '');
    for (let i = 0; i < LOADED; i += 150) {
      await Promise.all(
        Array.from({ length: Math.min(150, LOADED - i) }, (_, j) =>
          client.upsert(NS, toDocumentUuid(objectId(i + j)), {
            _id: objectId(i + j), _c: 'tasks', userId: 'u1', title: `t${i + j}`, status: 'todo',
            // Enough text that the collection (about 18 MiB) is past what one SQL reply may carry.
            description: BULK,
          })
        )
      );
    }
    const { rows } = await client.queryRaw(NS, 'SELECT COUNT(*) FROM docs');
    serverTruncates = Number(rows[0][0]) < LOADED;
    await client.close();

    await import('../src/models/index.ts');
    const { KdbDataStore } = await import('../src/data/kdb/store.ts');
    store = new KdbDataStore();
    await store.connect();
  });

  after(async () => {
    await store?.disconnect();
    service?.kill();
  });

  it('refuses a scan instead of answering from a truncated prefix', async (t) => {
    if (!serverTruncates) return t.skip('the server no longer truncates scans - retire the guard');
    await assert.rejects(store.collection('tasks').find({ userId: 'u1' }), { name: 'KdbScanCapError' });
    await assert.rejects(store.collection('tasks').countDocuments({}), { name: 'KdbScanCapError' });
  });

  it('still serves keyed reads and writes for documents past the cap', async (t) => {
    if (!serverTruncates) return t.skip('the server no longer truncates scans');
    const tasks = store.collection('tasks');
    const last = objectId(LOADED - 1);
    assert.equal((await tasks.findById(last))?.title, `t${LOADED - 1}`);
    assert.equal((await tasks.updateOne({ _id: last }, { $set: { status: 'done' } })).modified, 1);
    assert.equal((await tasks.findById(last))?.status, 'done');
  });

  it('fails a delete past the cap loudly instead of reporting a removal that did not happen', async (t) => {
    if (!serverTruncates) return t.skip('the server no longer truncates scans');
    const tasks = store.collection('tasks');
    const last = objectId(LOADED - 2);
    await assert.rejects(tasks.deleteOne({ _id: last }), /delete of .* had no effect/);
    // ...and the document is still there, so the error told the truth.
    assert.ok(await tasks.findById(last));
    // A delete inside the cap still works: the first documents are reachable by the scan.
    assert.equal((await tasks.deleteOne({ _id: objectId(3) })).deleted, 1);
    assert.equal(await tasks.findById(objectId(3)), null);
  });

  it('answers selective queries and deletes past the old cap on a server with the fix', async (t) => {
    if (serverTruncates) return t.skip('this server still truncates scans');
    const tasks = store.collection('tasks');
    assert.equal((await tasks.find({ title: `t${LOADED - 1}` })).length, 1);
    assert.equal(await store.collection('users').countDocuments({}), 0);
    assert.equal((await tasks.deleteOne({ title: `t${LOADED - 2}` })).deleted, 1);
    assert.equal(await tasks.findById(objectId(LOADED - 2)), null);
  });

  it('does not serve one collection another collection\'s document by id', async () => {
    assert.equal(await store.collection('users').findById(objectId(5)), null);
  });

  it('can be switched off for a server that does not truncate', async () => {
    process.env.KDB_SERVER_ROW_CAP = '0';
    try {
      const docs = await store.collection('tasks').find({ title: 't1' });
      assert.equal(docs.length, 1);
    } finally {
      delete process.env.KDB_SERVER_ROW_CAP;
    }
  });

  it('reads a whole collection larger than one SQL reply may be', async () => {
    // Since KDB 0.8.0 an unpaged reply over 15 MiB is refused with RESOURCE_EXHAUSTED; a scan
    // that grows with the data has to be read a page at a time, and this one is about 18 MiB.
    // Counted, not assumed: earlier tests here delete a few.
    const expected = await store.collection('tasks').countDocuments({ userId: 'u1' });
    assert.ok(expected > 10_000, `fixture too small: ${expected}`);
    const all = await store.collection('tasks').find({ userId: 'u1' });
    assert.equal(all.length, expected);
    assert.equal(new Set(all.map((doc) => doc._id)).size, expected, 'a page boundary repeated or lost a document');
    assert.equal(all[all.length - 1]!.description, BULK);
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
