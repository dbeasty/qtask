/**
 * Local mode (QTASK_LOCAL): configuration, the device-token gate, the routes that are
 * unmounted, and /api/version. None of this needs a data store, so it runs everywhere;
 * the session and data round trip is in local-mode-kdb.test.ts.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request, { serve, type Test } from './helpers/http.js';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';

const TOKEN = 'unit-test-device-token-0123456789';

const {
  DEVICE_TOKEN_HEADER,
  defaultDataDir,
  isLocalMode,
  resolveDataDir,
  resolveLocalConfig,
  runtimeMode,
} = await import('../src/local/config.js');
const { tokensMatch } = await import('../src/local/auth.js');
const { dataPaths, ensureDataDirs, loadOrCreateDeviceIdentity, loadOrCreateSecrets } = await import(
  '../src/local/device.js'
);
const { resolveDataBackend } = await import('../src/data/index.js');

describe('local mode configuration', () => {
  it('is off unless QTASK_LOCAL is 1 or true', () => {
    assert.equal(isLocalMode({}), false);
    assert.equal(isLocalMode({ QTASK_LOCAL: '0' }), false);
    assert.equal(isLocalMode({ QTASK_LOCAL: '1' }), true);
    assert.equal(isLocalMode({ QTASK_LOCAL: 'true' }), true);
    assert.equal(runtimeMode({ QTASK_LOCAL: '1' }), 'local');
    assert.equal(runtimeMode({}), 'online');
  });

  it('defaults the data directory to Application Support/QTask on macOS', () => {
    assert.equal(defaultDataDir('darwin', '/Users/x', {}), '/Users/x/Library/Application Support/QTask');
    assert.equal(defaultDataDir('linux', '/home/x', {}), '/home/x/.local/share/QTask');
    assert.equal(defaultDataDir('linux', '/home/x', { XDG_DATA_HOME: '/data' }), '/data/QTask');
  });

  it('lets QTASK_DATA_DIR override the data directory', () => {
    assert.equal(resolveDataDir({ QTASK_DATA_DIR: '/tmp/qtask-x' }), '/tmp/qtask-x');
    assert.equal(resolveDataDir({ QTASK_DATA_DIR: '  ' }), path.resolve(defaultDataDir()));
  });

  it('refuses to start without a device token of a sane length', () => {
    assert.throws(() => resolveLocalConfig({ QTASK_LOCAL: '1' }), /QTASK_DEVICE_TOKEN/);
    assert.throws(() => resolveLocalConfig({ QTASK_LOCAL: '1', QTASK_DEVICE_TOKEN: 'short' }), /QTASK_DEVICE_TOKEN/);
    const ok = resolveLocalConfig({ QTASK_LOCAL: '1', QTASK_DEVICE_TOKEN: TOKEN, QTASK_DATA_DIR: '/tmp/d' });
    assert.equal(ok.host, '127.0.0.1');
    assert.equal(ok.dataDir, '/tmp/d');
  });

  it('selects the embedded KDB store, and rejects Mongo alongside it', () => {
    assert.equal(resolveDataBackend({ QTASK_LOCAL: '1' }), 'kdb');
    assert.throws(() => resolveDataBackend({ QTASK_LOCAL: '1', DATA_MONGO: 'true' }), /DATA_MONGO/);
    assert.equal(resolveDataBackend({}), 'mongo');
  });
});

describe('device token comparison', () => {
  it('accepts only the exact token', () => {
    assert.equal(tokensMatch(TOKEN, TOKEN), true);
    assert.equal(tokensMatch(TOKEN + 'x', TOKEN), false);
    assert.equal(tokensMatch(TOKEN.slice(0, -1), TOKEN), false);
    assert.equal(tokensMatch('', TOKEN), false);
    assert.equal(tokensMatch(undefined, TOKEN), false);
    assert.equal(tokensMatch(['a', 'b'], TOKEN), false);
  });
});

describe('device identity and data directory', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qtask-local-device-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the layout owner-only', () => {
    const paths = ensureDataDirs(dir);
    for (const d of [paths.root, paths.kdbDir, paths.uploadsDir, paths.logsDir]) {
      assert.equal(statSync(d).mode & 0o077, 0, `${d} must not be group/world accessible`);
    }
  });

  it('mints a stable device identity and keeps the private key private', () => {
    const first = loadOrCreateDeviceIdentity(dir);
    const second = loadOrCreateDeviceIdentity(dir);
    assert.deepEqual(second, first);
    assert.match(first.deviceId, /^[0-9a-f-]{36}$/);
    const paths = dataPaths(dir);
    assert.equal(statSync(paths.deviceKeyFile).mode & 0o077, 0);
    assert.ok(!readFileSync(paths.deviceFile, 'utf8').includes('PRIVATE'));
  });

  it('gives different directories different identities', () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'qtask-local-device-'));
    try {
      assert.notEqual(loadOrCreateDeviceIdentity(other).deviceId, loadOrCreateDeviceIdentity(dir).deviceId);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a public key that does not belong to the private key', () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'qtask-local-device-'));
    try {
      loadOrCreateDeviceIdentity(other);
      writeFileSync(dataPaths(other).deviceKeyFile, readFileSync(dataPaths(dir).deviceKeyFile));
      assert.throws(() => loadOrCreateDeviceIdentity(other), /do not belong together/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('generates session secrets once and keeps them private', () => {
    const a = loadOrCreateSecrets(dir);
    const b = loadOrCreateSecrets(dir);
    assert.deepEqual(b, a);
    assert.ok(a.jwtSecret.length >= 48);
    assert.notEqual(a.jwtSecret, a.adminJwtSecret);
    assert.equal(statSync(dataPaths(dir).secretsFile).mode & 0o077, 0);
    assert.ok(existsSync(dataPaths(dir).secretsFile));
  });
});

describe('the local-mode app', () => {
  let app: Express;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qtask-local-app-'));
    process.env.QTASK_LOCAL = '1';
    process.env.QTASK_DEVICE_TOKEN = TOKEN;
    process.env.QTASK_DATA_DIR = dir;
    const { createApp } = await import('../src/app.js');
    app = await serve(await createApp({ connect: false, startWorker: false }));
  });
  after(() => {
    delete process.env.QTASK_LOCAL;
    rmSync(dir, { recursive: true, force: true });
  });

  const authed = (req: Test) => req.set(DEVICE_TOKEN_HEADER, TOKEN);

  it('rejects every request that lacks the device token', async () => {
    for (const p of ['/health', '/api/version', '/api/tasks', '/api/auth/me', '/']) {
      const res = await request(app).get(p);
      assert.equal(res.status, 403, p);
    }
    await request(app).get('/api/version').set(DEVICE_TOKEN_HEADER, 'wrong').expect(403);
    await request(app).post('/api/auth/local-session').expect(403);
  });

  it('reports mode "local" from /api/version', async () => {
    const res = await authed(request(app).get('/api/version')).expect(200);
    assert.equal(res.body.mode, 'local');
    assert.equal(res.body.service, 'qtask');
    assert.ok(res.body.version);
  });

  it('reports the device in /health', async () => {
    const res = await authed(request(app).get('/health')).expect(200);
    assert.equal(res.body.mode, 'local');
    assert.equal(res.body.deviceId, loadOrCreateDeviceIdentity(dir).deviceId);
  });

  it('does not mount sign-in, registration or any online-only route', async () => {
    const gone: Array<['get' | 'post', string]> = [
      ['post', '/api/auth/login'],
      ['post', '/api/auth/register'],
      ['post', '/api/auth/forgot-password'],
      ['post', '/api/auth/oauth/exchange'],
      ['get', '/api/auth/oauth/google'],
      ['get', '/api/notifications'],
      ['get', '/api/invites'],
      ['post', '/api/feedback'],
      ['get', '/api/mcp-keys'],
      ['post', '/api/mcp'],
      ['get', '/api/oauth/consent'],
      ['get', '/api/conversations'],
      ['post', '/api/agent'],
      ['get', '/.well-known/oauth-authorization-server'],
    ];
    for (const [method, p] of gone) {
      const res = await authed(request(app)[method](p));
      assert.equal(res.status, 404, `${method.toUpperCase()} ${p} should be unmounted, got ${res.status}`);
    }
  });

  it('keeps the account surface a device does use', async () => {
    const cfg = await authed(request(app).get('/api/auth/config')).expect(200);
    assert.equal(cfg.body.registrationEnabled, false);
    // Mounted, and answering 401 for lack of a session rather than 404.
    await authed(request(app).get('/api/auth/me')).expect(401);
    await authed(request(app).get('/api/tasks')).expect(401);
  });
});

describe('online mode is unchanged', () => {
  it('serves /api/version with mode "online" and no device token', async () => {
    delete process.env.QTASK_LOCAL;
    const { createApp } = await import('../src/app.js');
    const app = await serve(await createApp({ connect: false, startWorker: false }));
    const res = await request(app).get('/api/version').expect(200);
    assert.equal(res.body.mode, 'online');
    // Sign-in is mounted: a bad body is a validation error, not a 404.
    const login = await request(app).post('/api/auth/login').send({});
    assert.notEqual(login.status, 404);
    assert.notEqual(login.status, 403);
  });
});
