import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function installFakeLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

installFakeLocalStorage();

describe('listAllTasks reassembles the complete task list across pages', () => {
  const originalFetch = globalThis.fetch;

  it('pages through offsets until every task has been fetched', async () => {
    const allTasks = Array.from({ length: 11 }, (_, i) => ({ _id: `t${i}`, title: `Task ${i}` }));
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (url: string) => {
      requestedUrls.push(String(url));
      const parsed = new URL(String(url), 'http://localhost');
      const limit = Number(parsed.searchParams.get('limit'));
      const offset = Number(parsed.searchParams.get('offset'));
      const page = allTasks.slice(offset, offset + limit);
      return new Response(
        JSON.stringify({ tasks: page, total: allTasks.length, limit, offset }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const { listAllTasks } = await import('../client/src/api/client.ts');
    const result = await listAllTasks(4);

    globalThis.fetch = originalFetch;

    assert.equal(result.length, 11);
    assert.deepEqual(
      result.map((t) => t._id),
      allTasks.map((t) => t._id)
    );
    // 11 tasks at page size 4 -> 3 requests (4, 4, 3).
    assert.equal(requestedUrls.length, 3);
  });

  it('stops immediately when there are no tasks at all', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tasks: [], total: 0, limit: 200, offset: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const { listAllTasks } = await import('../client/src/api/client.ts');
    const result = await listAllTasks();

    globalThis.fetch = originalFetch;
    assert.deepEqual(result, []);
  });
});
