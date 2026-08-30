import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { streamEvents } from '../src/routes/agent.ts';

process.env.NODE_ENV = 'test';

function fakeSseResponse() {
  const chunks: string[] = [];
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    writableEnded: false,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
      emitter.emit('finish');
    },
    chunks,
  });
}

describe('streamEvents SSE keepalive', () => {
  it('emits periodic status events while waiting for the next generator yield', async () => {
    const res = fakeSseResponse();
    const keepaliveMs = 40;

    async function* slowGenerator() {
      yield { type: 'status' as const, message: 'Starting…' };
      await new Promise((resolve) => setTimeout(resolve, keepaliveMs + 20));
      yield { type: 'done' as const, conversationId: 'abc', content: 'ok' };
    }

    await streamEvents(res as unknown as import('express').Response, slowGenerator(), undefined, {
      keepaliveMs,
    });

    const events = res.chunks
      .join('')
      .split('\n\n')
      .map((chunk) => chunk.replace(/^data: /, '').trim())
      .filter(Boolean)
      .map((json) => JSON.parse(json) as { type: string; message?: string });

    const statusEvents = events.filter((event) => event.type === 'status');
    assert.ok(statusEvents.length >= 2, `expected keepalive status events, got ${statusEvents.length}`);
    assert.equal(events.at(-1)?.type, 'done');
  });
});
