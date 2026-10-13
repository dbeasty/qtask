/**
 * A local-mode device (its own process and kdb-service) signing in to a cloud hub (the
 * real Express app with QTASK_SYNC_HUB on, Mongo in memory, in this process) through
 * POST /api/local-sync/cloud/sign-in, and a second device that is only paired with the
 * first adopting the same account through the peer hello.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { waitForNewestToken } from './helpers/testEmail.ts';
import { LocalDevice, freePort, kdbMissing, pairDevices, waitFor } from './helpers/local-device.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';
process.env.QTASK_SYNC_HUB = 'true';

describe('a device signs in to the cloud, and its paired device follows', { skip: kdbMissing, timeout: 300_000 }, () => {
  let mongo: MongoMemoryServer;
  let app: Express;
  let server: Server;
  let hubUrl: string;
  let a: LocalDevice;
  let b: LocalDevice;
  const email = 'mac-owner@example.com';
  const password = 'password1234';
  let account: { token: string; userId: string };

  before(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri();
    const { createApp } = await import('../src/app.ts');
    app = await createApp({ connect: true, startWorker: false });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const { testEmailOutbox } = await import('../src/services/emailService.ts');
    const previous = testEmailOutbox.verification.length;
    await request(app).post('/api/auth/register').send({ email, password, acceptLegal: true }).expect(201);
    const token = await waitForNewestToken(() => testEmailOutbox.verification, previous);
    await request(app).post('/api/auth/verify-email').send({ token }).expect(200);
    const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`).expect(200);
    account = { token: login.body.token, userId: me.body.user.id };

    const mdnsPort = await freePort();
    a = new LocalDevice({ name: 'Mac A', mdnsPort });
    b = new LocalDevice({ name: 'Mac B', mdnsPort });
    await Promise.all([a.start(), b.start()]);
  });

  after(async () => {
    await Promise.allSettled([a?.stop(), b?.stop()]);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const { disconnectData } = await import('../src/data/index.ts');
    await disconnectData();
    await mongoose.disconnect();
    await mongo?.stop();
  });

  const hubTasks = async () =>
    (await request(app).get('/api/tasks?limit=500').set('Authorization', `Bearer ${account.token}`).expect(200)).body.tasks as Array<{
      _id: string;
      title: string;
    }>;

  it('works offline with no account, then signs in and uploads the offline work', async () => {
    const offline = (await a.api('POST', '/api/tasks', { title: 'Written before signing in' })).body.task._id;
    const status = await a.status();
    assert.equal(status.cloud, null);
    assert.equal(status.device.signedIn, false);

    const wrong = await a.sync('POST', '/cloud/sign-in', { hubUrl, email, password: 'nope-nope-nope' });
    assert.equal(wrong.status, 400);

    const signIn = await a.sync('POST', '/cloud/sign-in', { hubUrl, email, password });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
    assert.equal(signIn.body.userId, account.userId);
    a.resetSession();
    const me = await a.api('GET', '/api/auth/me');
    assert.equal(me.body.user.id, account.userId, 'the device user is now the account');
    assert.ok((await a.tasks()).some((t) => t._id === offline), 'local data was re-owned, still visible');
    await waitFor('the offline task on the hub', async () => (await hubTasks()).some((t) => t._id === offline), 30_000);
    const s = await a.status();
    assert.equal(s.device.signedIn, true);
    assert.equal(s.cloud.hubUrl, hubUrl);
  });

  it('brings web edits down', async () => {
    const created = await request(app).post('/api/tasks').set('Authorization', `Bearer ${account.token}`).send({ title: 'Made on the web' }).expect(201);
    const id = created.body.task._id;
    await a.sync('POST', '/now');
    await waitFor('the web task on the device', async () => (await a.api('GET', `/api/tasks/${id}`)).status === 200, 30_000);
  });

  it('a paired device that never signed in adopts the account from its peer', async () => {
    const before = (await b.api('POST', '/api/tasks', { title: 'B offline work' })).body.task._id;
    await pairDevices(a, b);
    await waitFor('B to adopt the owner', async () => (await b.status()).device.ownerId === account.userId, 30_000);
    b.resetSession();
    const me = await b.api('GET', '/api/auth/me');
    assert.equal(me.body.user.id, account.userId);
    // B's offline task travels B -> A -> cloud.
    await waitFor('B offline work on the hub', async () => (await hubTasks()).some((t) => t._id === before), 30_000);
    // And everything A has is visible on B.
    const onA = (await a.tasks()).map((t) => t._id).sort();
    await waitFor('B has everything A has', async () => {
      const onB = new Set((await b.tasks()).map((t) => t._id));
      return onA.every((id) => onB.has(id));
    }, 30_000);
  });

  it('signing out stops cloud sync and keeps the data', async () => {
    assert.equal((await a.sync('POST', '/cloud/sign-out')).status, 200);
    const s = await a.status();
    assert.equal(s.cloud, null);
    assert.ok((await a.tasks()).length > 0);
  });
});
