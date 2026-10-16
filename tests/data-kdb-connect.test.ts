/**
 * How the KDB store opens its connection. @limidus/kdb-client takes `connect(addr, options)`; the store
 * used to pass KDB_TOKEN as the second argument itself, a bare string, which the client reads as
 * an options object with no `token` - so the token was never sent and every connection was
 * anonymous. Invisible against a server without access control, which is every test server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.DATA_KDB = 'true';
delete process.env.DATA_MONGO;
process.env.KDB_ADDR = 'tcp://127.0.0.1:1';
process.env.KDB_TOKEN = 'qtask:s3cret';
process.env.KDB_CLIENT_MODULE = resolve(import.meta.dirname, 'helpers/recordingKdbClient.ts');

describe('KDB store connection', () => {
  it('sends KDB_TOKEN as the client\'s token option', async () => {
    await import('../src/models/index.ts');
    const { KdbDataStore } = await import('../src/data/kdb/store.ts');
    const { calls } = (await import('./helpers/recordingKdbClient.ts')) as { calls: Array<{ addr: string; options: unknown }> };
    const store = new KdbDataStore();
    await store.connect();
    await store.disconnect();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.addr, 'tcp://127.0.0.1:1');
    assert.deepEqual(calls[0]!.options, { token: 'qtask:s3cret' });
  });

  it('does not count the whole namespace before reading', async () => {
    // The scan-cap guard that did (a namespace-wide COUNT(*) every few seconds, which with
    // --expire-field reads every document body) is retired: no server qtask can talk to truncates.
    await import('../src/models/index.ts');
    const { KdbDataStore } = await import('../src/data/kdb/store.ts');
    const { statements } = (await import('./helpers/recordingKdbClient.ts')) as { statements: string[] };
    const store = new KdbDataStore();
    await store.connect();
    try {
      statements.length = 0;
      await store.collection('tasks').find({ userId: 'u1' });
      assert.equal(statements.filter((sql) => /^SELECT COUNT\(\*\) FROM docs$/.test(sql)).length, 0);
    } finally {
      await store.disconnect();
    }
  });
});
