import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  loadSecrets,
  resolveSecretsBackend,
  SECRET_ENV_KEYS,
} from '../src/config/secrets.js';

describe('resolveSecretsBackend', () => {
  it('defaults to env', () => {
    assert.equal(resolveSecretsBackend({}), 'env');
    assert.equal(resolveSecretsBackend({ SECRETS_BACKEND: '' }), 'env');
    assert.equal(resolveSecretsBackend({ SECRETS_BACKEND: 'env' }), 'env');
  });

  it('accepts vault', () => {
    assert.equal(resolveSecretsBackend({ SECRETS_BACKEND: 'vault' }), 'vault');
    assert.equal(resolveSecretsBackend({ SECRETS_BACKEND: 'Vault' }), 'vault');
  });

  it('rejects unknown backends', () => {
    assert.throws(() => resolveSecretsBackend({ SECRETS_BACKEND: 'aws' }), /must be "env" or "vault"/);
  });
});

describe('loadSecrets', () => {
  const originalFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};

  function stash(keys: string[]) {
    for (const key of keys) {
      saved[key] = process.env[key];
    }
  }

  function restore() {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(saved)) delete saved[key];
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
    restore();
    delete process.env.SECRETS_BACKEND;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_SECRET_PATH;
    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
    for (const key of SECRET_ENV_KEYS) {
      // clean keys we may have set during tests
      if (saved[key] === undefined && process.env[key] !== undefined) {
        // left for restore above
      }
    }
  });

  it('is a no-op for env backend', async () => {
    const fetchMock = mock.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await loadSecrets({ SECRETS_BACKEND: 'env' });
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('loads secrets from Vault via AppRole', async () => {
    stash(['JWT_SECRET', 'MONGODB_URI', 'SECRETS_BACKEND', 'VAULT_ROLE_ID', 'VAULT_SECRET_ID', 'VAULT_ADDR']);
    process.env.SECRETS_BACKEND = 'vault';
    process.env.VAULT_ROLE_ID = 'role-test';
    process.env.VAULT_SECRET_ID = 'secret-test';
    process.env.VAULT_ADDR = 'http://vault.test:8200';
    delete process.env.JWT_SECRET;
    delete process.env.MONGODB_URI;

    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/approle/login')) {
        assert.equal(init?.method, 'POST');
        return new Response(JSON.stringify({ auth: { client_token: 'tok-abc' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v1/secret/data/qtask/production')) {
        assert.equal((init?.headers as Record<string, string>)['X-Vault-Token'], 'tok-abc');
        return new Response(
          JSON.stringify({
            data: {
              data: {
                JWT_SECRET: 'from-vault',
                MONGODB_URI: 'mongodb://vault/qtask',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ errors: ['not found'] }), { status: 404 });
    }) as unknown as typeof fetch;

    await loadSecrets();
    assert.equal(process.env.JWT_SECRET, 'from-vault');
    assert.equal(process.env.MONGODB_URI, 'mongodb://vault/qtask');
  });

  it('requires AppRole credentials in vault mode', async () => {
    stash(['VAULT_ROLE_ID', 'VAULT_SECRET_ID', 'CREDENTIALS_DIRECTORY']);
    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
    delete process.env.CREDENTIALS_DIRECTORY;

    await assert.rejects(
      () => loadSecrets({ SECRETS_BACKEND: 'vault' }),
      /AppRole credentials missing/,
    );
  });
});
