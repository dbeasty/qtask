import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequestAbortSignal } from '../src/routes/agent.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

/**
 * A minimal fake of express.Response sufficient for createRequestAbortSignal:
 * it only needs .on('close', ...) and a mutable .writableEnded.
 */
function fakeResponse(writableEnded: boolean) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { writableEnded }) as EventEmitter & { writableEnded: boolean };
}

describe('createRequestAbortSignal', () => {
  it('aborts when the connection closes before the response finished (real client disconnect)', () => {
    const res = fakeResponse(false);
    const signal = createRequestAbortSignal(res as unknown as import('express').Response);

    assert.equal(signal.aborted, false);
    res.emit('close');
    assert.equal(signal.aborted, true);
  });

  it('does not abort when close fires after the response already finished normally', () => {
    const res = fakeResponse(false);
    const signal = createRequestAbortSignal(res as unknown as import('express').Response);

    // Simulate the response completing before the underlying connection's
    // close event fires — the bug this regression test guards against had
    // req.on('close') firing ~1ms after the request body was consumed,
    // while the client was still connected and the response still open.
    res.writableEnded = true;
    res.emit('close');
    assert.equal(signal.aborted, false);
  });

  it('is idempotent if close fires more than once', () => {
    const res = fakeResponse(false);
    const signal = createRequestAbortSignal(res as unknown as import('express').Response);

    res.emit('close');
    assert.equal(signal.aborted, true);
    assert.doesNotThrow(() => res.emit('close'));
  });
});
