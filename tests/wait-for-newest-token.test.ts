import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForNewestToken } from './helpers/testEmail.js';

describe('waitForNewestToken', () => {
  it('returns immediately when the outbox already grew before the call', async () => {
    const tokens = ['a', 'b'];
    const result = await waitForNewestToken(() => tokens, 1);
    assert.equal(result, 'b');
  });

  it('polls until a token appended after the call shows up', async () => {
    const tokens: string[] = ['a'];
    setTimeout(() => tokens.push('b'), 30);

    const result = await waitForNewestToken(() => tokens, 1);
    assert.equal(result, 'b');
  });

  it('times out instead of returning a stale/wrong token if nothing new arrives', async () => {
    const tokens = ['a'];
    await assert.rejects(
      () => waitForNewestToken(() => tokens, 1, 50),
      /Timed out waiting for a new token/
    );
  });
});
