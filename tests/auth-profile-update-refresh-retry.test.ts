import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

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

describe('updateProfile/updatePreferences retry once after refreshing an expired token', () => {
  const originalFetch = globalThis.fetch;

  before(() => {
    (globalThis as { localStorage: Storage }).localStorage.clear();
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('refreshes the token and retries once instead of failing immediately on a 401', async () => {
    const { setStoredToken } = await import('../client/src/auth/storage.ts');
    setStoredToken('expired-token');

    const calls: Array<{ url: string; method?: string; auth?: string }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ url: String(url), method: init?.method, auth });

      if (String(url) === '/api/auth/refresh') {
        return new Response(
          JSON.stringify({ token: 'fresh-token', user: { _id: 'u1', email: 'a@example.com' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (String(url) === '/api/auth/me' && auth === 'Bearer expired-token') {
        return new Response(JSON.stringify({ error: 'Token expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (String(url) === '/api/auth/me' && auth === 'Bearer fresh-token') {
        return new Response(JSON.stringify({ user: { _id: 'u1', email: 'a@example.com', hourlyRate: 50 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { updateProfile, getStoredToken } = await import('../client/src/auth/storage.ts');
    const result = await updateProfile({ hourlyRate: 50 });

    assert.equal(result.user.hourlyRate, 50);
    assert.equal(getStoredToken(), 'fresh-token', 'the refreshed token must be persisted');

    const meCalls = calls.filter((c) => c.url === '/api/auth/me');
    assert.equal(meCalls.length, 2, 'expected the original 401 call plus one retry after refresh');
    assert.equal(meCalls[0]?.auth, 'Bearer expired-token');
    assert.equal(meCalls[1]?.auth, 'Bearer fresh-token');
  });
});
