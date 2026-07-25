import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AbortError,
  isAborted,
  linkAbortSignals,
  throwIfAborted,
} from '../src/utils/abortSignal.ts';

describe('abortSignal', () => {
  it('throwIfAborted throws AbortError when signal is aborted', () => {
    const controller = new AbortController();
    controller.abort();
    assert.throws(() => throwIfAborted(controller.signal), AbortError);
  });

  it('isAborted returns false for undefined signal', () => {
    assert.equal(isAborted(undefined), false);
  });

  it('linkAbortSignals aborts when any linked signal aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const linked = linkAbortSignals(a.signal, b.signal);

    assert.equal(linked.aborted, false);
    b.abort();
    assert.equal(linked.aborted, true);
  });

  it('linkAbortSignals is already aborted when input signal is aborted', () => {
    const a = new AbortController();
    a.abort();
    const linked = linkAbortSignals(a.signal);
    assert.equal(linked.aborted, true);
  });
});

describe('runAgentLoop abort handling', () => {
  it('AbortError is distinguishable from generic errors', () => {
    const error = new AbortError('stopped');
    assert.equal(error.name, 'AbortError');
    assert.equal(error.message, 'stopped');
  });
});
