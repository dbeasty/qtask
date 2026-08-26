import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockAgentSend } from '../client/src/utils/agentSendGuard.ts';

describe('shouldBlockAgentSend', () => {
  it('blocks a second send while the first fresh-conversation stream is in flight', () => {
    assert.equal(shouldBlockAgentSend(true, null, undefined), true);
  });

  it('blocks while a proposal approval on a fresh conversation is in flight', () => {
    assert.equal(shouldBlockAgentSend(false, 'prop-1', undefined), true);
  });

  it('allows interrupting an in-flight stream once the conversation id is known', () => {
    assert.equal(shouldBlockAgentSend(true, null, 'conv-123'), false);
  });

  it('allows sending when nothing is in flight', () => {
    assert.equal(shouldBlockAgentSend(false, null, undefined), false);
    assert.equal(shouldBlockAgentSend(false, null, 'conv-123'), false);
  });
});
