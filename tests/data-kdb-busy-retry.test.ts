/**
 * kdb-service refuses a read with BUSY (retryable, with a retry-after hint) when it is in a high
 * memory-pressure zone. The restore drill hit it on a 110,000-document namespace; the store used to
 * hand it straight to the caller. Reads are now retried a few times; other errors are not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

class KdbBusyError extends Error {
  code = 'BUSY';
  constructor(readonly retryAfterMs = 1) {
    super('kdb: server busy: kdb server: rejecting scan - memory pressure zone high (retry after 1ms)');
  }
}

describe('retryWhenBusy', () => {
  it('retries a read the server refused as busy, then returns its answer', async () => {
    const { retryWhenBusy } = await import('../src/data/kdb/store.ts');
    let calls = 0;
    const result = await retryWhenBusy(async () => {
      calls++;
      if (calls < 3) throw new KdbBusyError();
      return 'rows';
    });
    assert.equal(result, 'rows');
    assert.equal(calls, 3);
  });

  it('gives up after a bounded number of attempts and surfaces the refusal', async () => {
    const { retryWhenBusy } = await import('../src/data/kdb/store.ts');
    let calls = 0;
    await assert.rejects(retryWhenBusy(async () => { calls++; throw new KdbBusyError(); }, 4), /memory pressure/);
    assert.equal(calls, 4);
  });

  it('does not retry anything else', async () => {
    const { retryWhenBusy } = await import('../src/data/kdb/store.ts');
    let calls = 0;
    const exhausted = Object.assign(new Error('result too large'), { code: 'RESOURCE_EXHAUSTED' });
    await assert.rejects(retryWhenBusy(async () => { calls++; throw exhausted; }), /too large/);
    assert.equal(calls, 1);
  });
});
