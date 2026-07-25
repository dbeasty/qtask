import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let app: Express;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();

  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

beforeEach(async () => {
  const { clearTestEmailOutbox } = await import('../src/services/emailService.js');
  clearTestEmailOutbox();
});

after(async () => {
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

async function registerAndVerify(email: string, password = 'password1234') {
  await request(app)
    .post('/api/auth/register')
    .send({ email, password, acceptLegal: true })
    .expect(201);

  const { testEmailOutbox } = await import('../src/services/emailService.js');
  const token = testEmailOutbox.verification.at(-1);
  assert.ok(token);

  await request(app).post('/api/auth/verify-email').send({ token }).expect(200);

  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);

  const me = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${login.body.token}`)
    .expect(200);

  return { token: login.body.token as string, userId: me.body.user.id as string, email };
}

describe('project invites and notifications', () => {
  it('creates invite, notifies recipient, and grants access on accept', async () => {
    const alice = await registerAndVerify('invite-alice@example.com');
    const bob = await registerAndVerify('invite-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Invite Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Shared work', projectId })
      .expect(201);

    const inviteRes = await request(app)
      .post(`/api/projects/${projectId}/invites`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: bob.email, role: 'editor' })
      .expect(201);

    const inviteId = inviteRes.body.invite._id as string;
    assert.equal(inviteRes.body.invite.status, 'pending');

    const { testEmailOutbox } = await import('../src/services/emailService.js');
    assert.equal(testEmailOutbox.projectInvite.length, 1);
    assert.match(testEmailOutbox.projectInviteBodies[0] ?? '', /Invite Project/);

    const bobInvites = await request(app)
      .get('/api/invites')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(bobInvites.body.invites.length, 1);

    const bobNotifications = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.ok(
      bobNotifications.body.notifications.some(
        (n: { type: string }) => n.type === 'project_invite'
      )
    );

    await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200)
      .then((res) => {
        assert.equal(
          res.body.projects.some((p: { _id: string }) => p._id === projectId),
          false
        );
      });

    const accepted = await request(app)
      .post(`/api/invites/${inviteId}/accept`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    assert.equal(accepted.body.invite.status, 'accepted');
    assert.equal(accepted.body.project._id, projectId);
    assert.equal(testEmailOutbox.projectShareAccepted.length, 1);

    const aliceNotifications = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    assert.ok(
      aliceNotifications.body.notifications.some(
        (n: { type: string }) => n.type === 'project_share_accepted'
      )
    );

    const bobTasks = await request(app)
      .get('/api/tasks')
      .query({ projectId })
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(bobTasks.body.tasks.length, 1);
  });

  it('declines invite and notifies sender', async () => {
    const alice = await registerAndVerify('decline-alice@example.com');
    const bob = await registerAndVerify('decline-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Decline Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const inviteRes = await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: bob.email, role: 'viewer' })
      .expect(201);

    const inviteId = inviteRes.body.invite._id as string;

    await request(app)
      .post(`/api/invites/${inviteId}/decline`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    const { testEmailOutbox } = await import('../src/services/emailService.js');
    assert.equal(testEmailOutbox.projectShareDeclined.length, 1);

    const aliceNotifications = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    assert.ok(
      aliceNotifications.body.notifications.some(
        (n: { type: string }) => n.type === 'project_share_declined'
      )
    );
  });

  it('lets owner cancel a pending invite and exposes share summary', async () => {
    const alice = await registerAndVerify('cancel-alice@example.com');
    const bob = await registerAndVerify('cancel-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Summary Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const childRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Child', parentId: projectId })
      .expect(201);
    const childId = childRes.body.project._id as string;

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Root task', projectId })
      .expect(201);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Child task', projectId: childId })
      .expect(201);

    const summary = await request(app)
      .get(`/api/projects/${projectId}/share-summary`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    assert.equal(summary.body.summary.directTaskCount, 1);
    assert.equal(summary.body.summary.descendantProjectCount, 1);
    assert.equal(summary.body.summary.descendantTaskCount, 1);
    assert.equal(summary.body.summary.totalTaskCount, 2);

    const inviteRes = await request(app)
      .post(`/api/projects/${projectId}/invites`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: bob.email, role: 'editor' })
      .expect(201);

    await request(app)
      .delete(`/api/projects/${projectId}/invites/${inviteRes.body.invite._id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    const pending = await request(app)
      .get(`/api/projects/${projectId}/invites`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    assert.equal(pending.body.invites.length, 0);
  });
});
