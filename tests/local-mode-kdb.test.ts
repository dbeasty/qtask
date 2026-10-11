/**
 * Local mode against a real kdb-service: the session handshake and a task round trip
 * through the whole HTTP stack. Skips (rather than fails) when no kdb-service binary or
 * @kdb/client is available, as the KDB conformance suite does.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolve } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';

const KDB_ROOT = process.env.KDB_ROOT ?? resolve(import.meta.dirname, '../../kdb');
const CLIENT_MODULE = process.env.KDB_CLIENT_MODULE ?? resolve(KDB_ROOT, 'packages/kdb-client/src/index.ts');
const SERVICE_BIN = process.env.KDB_SERVICE_BIN ?? resolve(KDB_ROOT, 'go/bin/kdb-service');
const PORT = Number(process.env.KDB_TEST_PORT_LOCAL ?? 7812);
const TOKEN = 'kdb-test-device-token-0123456789';
const NAMESPACE = 'qtasklocal/docs';

const skip = !existsSync(SERVICE_BIN)
  ? `kdb-service not built at ${SERVICE_BIN}`
  : !existsSync(CLIENT_MODULE)
    ? `@kdb/client not found at ${CLIENT_MODULE}`
    : undefined;

describe('local mode on KDB', { skip }, () => {
  let service: ChildProcess | undefined;
  let app: Express;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qtask-local-kdb-'));
    process.env.QTASK_LOCAL = '1';
    process.env.QTASK_DEVICE_TOKEN = TOKEN;
    process.env.QTASK_DATA_DIR = dir;
    process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
    process.env.KDB_ADDR = `tcp://127.0.0.1:${PORT}`;
    process.env.KDB_NAMESPACE_PREFIX = NAMESPACE;

    service = spawn(
      SERVICE_BIN,
      [
        '--memory',
        '--namespace',
        NAMESPACE,
        '--sql-addr',
        `tcp://127.0.0.1:${PORT}?bind=true`,
        '--peer-addr',
        '',
        '--stream-addr',
        '',
        '--log-level',
        'error',
      ],
      { stdio: 'ignore' }
    );
    await waitForPort(PORT);

    const { createApp } = await import('../src/app.js');
    app = await createApp({ startWorker: false });
  });

  after(async () => {
    const { disconnectDb } = await import('../src/db/connection.js');
    await disconnectDb();
    service?.kill();
    delete process.env.QTASK_LOCAL;
    rmSync(dir, { recursive: true, force: true });
  });

  const dev = (req: request.Test) => req.set('x-qtask-device-token', TOKEN);

  it('issues a session for the one local user, idempotently', async () => {
    const a = await dev(request(app).post('/api/auth/local-session')).expect(200);
    const b = await dev(request(app).post('/api/auth/local-session')).expect(200);
    assert.ok(a.body.token);
    assert.equal(a.body.user.id, b.body.user.id);
    assert.equal(a.body.user.hasPassword, false);
    // The session is an ordinary Bearer token for the unchanged API.
    const me = await dev(request(app).get('/api/auth/me')).set('Authorization', `Bearer ${a.body.token}`).expect(200);
    assert.equal(me.body.user.id, a.body.user.id);
  });

  it('creates, updates, searches and deletes tasks without any network', async () => {
    const { body } = await dev(request(app).post('/api/auth/local-session')).expect(200);
    const auth = { Authorization: `Bearer ${body.token}` };

    const projects = await dev(request(app).get('/api/projects')).set(auth).expect(200);
    assert.equal(projects.body.projects.length, 1, 'a default project is created for the local user');
    const projectId = projects.body.projects[0]._id;

    const created = await dev(request(app).post('/api/tasks')).set(auth).send({ title: 'Buy oat milk', projectId }).expect(201);
    const id = created.body.task._id;

    await dev(request(app).patch(`/api/tasks/${id}`)).set(auth).send({ status: 'done' }).expect(200);
    const listed = await dev(request(app).get('/api/tasks')).set(auth).expect(200);
    assert.equal(listed.body.tasks.find((t: { _id: string }) => t._id === id).status, 'done');

    const found = await dev(request(app).get('/api/search?q=oat')).set(auth).expect(200);
    assert.ok(JSON.stringify(found.body).includes('Buy oat milk'));

    await dev(request(app).delete(`/api/tasks/${id}`)).set(auth).expect(204);
    const after = await dev(request(app).get('/api/tasks')).set(auth).expect(200);
    assert.equal(after.body.tasks.some((t: { _id: string }) => t._id === id), false);
  });

  it('does not queue embedding jobs, since there is no model to run them', async () => {
    const { collection } = await import('../src/data/index.js');
    assert.equal(await collection('embeddingJobs').countDocuments({}), 0);
  });
});

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((done) => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        done(true);
      });
      socket.once('error', () => done(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`kdb-service did not open port ${port}`);
}
