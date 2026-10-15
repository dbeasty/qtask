/**
 * An offline device syncing with the real Express app (Mongo-backed, sync hub on)
 * over real HTTP, the way the shipped client does.
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from './helpers/http.js';
import type { Express } from 'express';
import { waitForNewestToken } from './helpers/testEmail.ts';
import { makePeer, type Peer } from './helpers/syncHarness.ts';
import { HttpSyncTransport } from '../src/sync/transport.ts';
import { adoptLocalAccount } from '../src/sync/adopt.ts';
import { DeviceSyncClient } from '../src/sync/client.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';
process.env.QTASK_SYNC_HUB = 'true';

let mongo: MongoMemoryServer;
let app: Express;
let server: Server;
let baseUrl: string;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { createApp } = await import('../src/app.ts');
  app = await createApp({ connect: true, startWorker: false });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.ts');
  stopEmbeddingWorker();
  const { disconnectData } = await import('../src/data/index.ts');
  await disconnectData();
  await mongoose.disconnect();
  await mongo.stop();
});

async function registerAndVerify(email: string, password = 'password1234') {
  const { testEmailOutbox } = await import('../src/services/emailService.ts');
  const previous = testEmailOutbox.verification.length;
  await request(server).post('/api/auth/register').send({ email, password, acceptLegal: true }).expect(201);
  const token = await waitForNewestToken(() => testEmailOutbox.verification, previous);
  await request(server).post('/api/auth/verify-email').send({ token }).expect(200);
  const login = await request(server).post('/api/auth/login').send({ email, password }).expect(200);
  const me = await request(server).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`).expect(200);
  return { token: login.body.token as string, userId: me.body.user.id as string };
}

const taskShape = (userId: string, projectId: string, title: string) => ({
  userId,
  projectId,
  projectIds: [projectId],
  title,
  status: 'todo',
  priority: 'medium',
  tags: [],
  steps: [],
  subtasks: [],
  links: [],
  percentComplete: 0,
  sortOrder: 0,
});

function deviceClient(device: Peer, token: () => string | undefined) {
  return new DeviceSyncClient({
    engine: device.engine,
    transport: new HttpSyncTransport({ baseUrl, getToken: token }),
    getToken: token,
  });
}

describe('device <-> hub through the real app', () => {
  it('rejects unauthenticated sync calls', async () => {
    await request(server).post('/api/sync/hello').send({}).expect(401);
    await request(server).post('/api/sync/pull').send({}).expect(401);
    await request(server).post('/api/sync/push').send({ from: 'x', docs: [] }).expect(401);
  });

  it('syncs offline work up, web edits down, and converges a same-field conflict', async () => {
    const user = await registerAndVerify('sync-user@example.com');
    const device = await makePeer('mac');
    const local = 'local-device-user';
    let token: string | undefined;
    const client = deviceClient(device, () => token);

    // --- offline: build a project and tasks under the local user -----------------
    const project = await device.store.collection('projects').create({
      userId: local, name: 'Offline project', collaborators: [], status: 'todo', percentComplete: 0, sortOrder: 0,
    });
    const projectId = String(project._id);
    const t1 = await device.store.collection('tasks').create(taskShape(local, projectId, 'written on the plane'));
    const t2 = await device.store.collection('tasks').create(taskShape(local, projectId, 'also on the plane'));
    await device.store.collection('comments').create({ userId: local, taskId: String(t1._id), body: 'offline note' });

    assert.equal(await client.syncNow(), undefined, 'not signed in: no network');
    assert.equal((await client.status()).pendingChanges, 4);

    // --- sign in: adopt the account, then sync ---------------------------------
    token = user.token;
    await adoptLocalAccount(device.engine, local, user.userId);
    const first = await client.syncNow();
    assert.equal(first?.rejected.length, 0, JSON.stringify(first?.rejected));
    assert.equal((await client.status()).pendingChanges, 0);

    // the existing REST API reads the same store, so the web sees the offline work
    const tasks = await request(server).get('/api/tasks').set('Authorization', `Bearer ${user.token}`).expect(200);
    const titles = (tasks.body.tasks as Array<{ title: string }>).map((t) => t.title).sort();
    assert.ok(titles.includes('written on the plane'));
    assert.ok(titles.includes('also on the plane'));
    const comments = await request(server).get(`/api/tasks/${t1._id}/comments`).set('Authorization', `Bearer ${user.token}`).expect(200);
    assert.equal(comments.body.comments.length, 1);

    // --- a repeat sync is a no-op ----------------------------------------------
    const noop = await client.syncNow();
    assert.equal(noop?.pushed, 0);
    assert.equal(noop?.pulled, 0);

    // --- web edit comes down ---------------------------------------------------
    await request(server).patch(`/api/tasks/${t2._id}`).set('Authorization', `Bearer ${user.token}`).send({ priority: 'high' }).expect(200);
    const down = await client.syncNow();
    assert.ok((down?.pulled ?? 0) >= 1);
    assert.equal((await device.inner.collection('tasks').findById(String(t2._id)))?.priority, 'high');

    // --- same field edited on both sides while apart --------------------------
    await device.store.collection('tasks').updateOne({ _id: t1._id }, { $set: { title: 'device title' } });
    await new Promise((r) => setTimeout(r, 5));
    await request(server).patch(`/api/tasks/${t1._id}`).set('Authorization', `Bearer ${user.token}`).send({ title: 'web title' }).expect(200);
    const merged = await client.syncNow();
    assert.ok(merged);
    await client.syncNow();
    const webTitle = (await request(server).get(`/api/tasks/${t1._id}`).set('Authorization', `Bearer ${user.token}`).expect(200)).body.task.title;
    const deviceTitle = (await device.inner.collection('tasks').findById(String(t1._id)))?.title;
    assert.equal(webTitle, 'web title', 'later write wins on the hub');
    assert.equal(deviceTitle, 'web title', 'and on the device');

    // the loser is in the activity log both can read
    const activity = await request(server).get(`/api/tasks/${t1._id}/activity`).set('Authorization', `Bearer ${user.token}`).expect(200);
    const entries = JSON.stringify(activity.body);
    assert.match(entries, /sync_conflict|device title/);
    const deviceLog = await device.inner.collection('activities').find({ action: 'sync_conflict' });
    assert.equal(deviceLog.length, 1);

    // --- delete on the web removes it from the device --------------------------
    await request(server).delete(`/api/tasks/${t2._id}`).set('Authorization', `Bearer ${user.token}`).expect(204);
    await client.syncNow();
    assert.equal(await device.inner.collection('tasks').findById(String(t2._id)), null);
  });

  it('keeps one user\'s documents out of another user\'s device', async () => {
    const owner = await registerAndVerify('sync-owner@example.com');
    const other = await registerAndVerify('sync-other@example.com');
    const projectRes = await request(server).post('/api/projects').set('Authorization', `Bearer ${owner.token}`).send({ name: 'Private' }).expect(201);
    await request(server).post('/api/tasks').set('Authorization', `Bearer ${owner.token}`).send({ title: 'secret', projectId: projectRes.body.project._id }).expect(201);

    const device = await makePeer('other-phone');
    const client = deviceClient(device, () => other.token);
    await client.syncNow();
    const seen = JSON.stringify([
      ...(await device.inner.collection('tasks').find({})),
      ...(await device.inner.collection('projects').find({})),
    ]);
    assert.ok(!seen.includes('secret'));
    assert.ok(!seen.includes('Private'));
  });

  it('enforces collaborator roles on push', async () => {
    const owner = await registerAndVerify('sync-role-owner@example.com');
    const viewer = await registerAndVerify('sync-role-viewer@example.com');
    const projectRes = await request(server).post('/api/projects').set('Authorization', `Bearer ${owner.token}`).send({ name: 'Roles' }).expect(201);
    const projectId = projectRes.body.project._id as string;
    const taskRes = await request(server).post('/api/tasks').set('Authorization', `Bearer ${owner.token}`).send({ title: 'read only for viewers', projectId }).expect(201);
    const taskId = taskRes.body.task._id as string;
    const invite = await request(server).post(`/api/projects/${projectId}/collaborators`).set('Authorization', `Bearer ${owner.token}`).send({ email: 'sync-role-viewer@example.com', role: 'viewer' }).expect(201);
    await request(server).post(`/api/invites/${invite.body.invite._id}/accept`).set('Authorization', `Bearer ${viewer.token}`).expect(200);

    const device = await makePeer('viewer-phone');
    const client = deviceClient(device, () => viewer.token);
    await client.syncNow();
    assert.equal((await device.inner.collection('tasks').findById(taskId))?.title, 'read only for viewers');

    await device.store.collection('tasks').updateOne({ _id: taskId }, { $set: { title: 'viewer rewrote it' } });
    const result = await client.syncNow();
    assert.ok((result?.rejected.length ?? 0) >= 1, 'viewer push was refused');
    const onHub = await request(server).get(`/api/tasks/${taskId}`).set('Authorization', `Bearer ${owner.token}`).expect(200);
    assert.equal(onHub.body.task.title, 'read only for viewers');
  });

  it('accepts a push larger than the API\'s 1mb JSON limit', async () => {
    const user = await registerAndVerify('sync-big@example.com');
    const device = await makePeer('big');
    const local = 'local-big';
    const project = await device.store.collection('projects').create({ userId: local, name: 'Big', collaborators: [], sortOrder: 0 });
    const filler = 'x'.repeat(4000);
    for (let i = 0; i < 400; i++) {
      await device.store.collection('tasks').create({ ...taskShape(local, String(project._id), `big ${i}`), description: filler });
    }
    await adoptLocalAccount(device.engine, local, user.userId);
    const client = deviceClient(device, () => user.token);
    const result = await client.syncNow();
    assert.equal(result?.rejected.length, 0);
    const { collection } = await import('../src/data/index.ts');
    assert.equal(await collection('tasks').countDocuments({ userId: user.userId }), 400);
  });
});
