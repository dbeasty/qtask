import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { consumeSseStream } from '../client/src/api/client.ts';

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe('consumeSseStream tolerates a malformed frame instead of dying', () => {
  it('skips one malformed data frame and still delivers the events around it', async () => {
    const events: unknown[] = [];
    const response = sseResponse([
      'data: {"type":"chunk","content":"first"}\n\n',
      'data: {not valid json\n\n',
      'data: {"type":"chunk","content":"second"}\n\n',
    ]);

    await consumeSseStream(response, (event) => {
      events.push(event);
    });

    assert.deepEqual(events, [
      { type: 'chunk', content: 'first' },
      { type: 'chunk', content: 'second' },
    ]);
  });

  it('removes its abort listener after the stream ends normally', async () => {
    const controller = new AbortController();
    const response = sseResponse(['data: {"type":"chunk","content":"only"}\n\n']);

    const addSpy: Array<{ type: string }> = [];
    const removeSpy: Array<{ type: string }> = [];
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      addSpy.push({ type });
      return (originalAdd as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removeSpy.push({ type });
      return (originalRemove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof controller.signal.removeEventListener;

    await consumeSseStream(response, () => {}, controller.signal);

    assert.equal(addSpy.length, 1, 'expected the abort listener to be registered');
    assert.equal(
      removeSpy.length,
      1,
      'expected the abort listener to be cleaned up once the stream finishes normally'
    );
  });
});
