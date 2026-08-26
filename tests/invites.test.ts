import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { waitForNewestToken } from './helpers/testEmail.js';

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
  const { testEmailOutbox } = await import('../src/services/emailService.js');
  const previousTokenCount = testEmailOutbox.verification.length;

  await request(app)
    .post('/api/auth/register')
    .send({ email, password, acceptLegal: true })
    .expect(201);

  const token = await waitForNewestToken(() => testEmailOutbox.verification, previousTokenCount);

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

  it('creates invite for non-user email without notification', async () => {
    const alice = await registerAndVerify('nonuser-alice@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'New User Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const inviteRes = await request(app)
      .post(`/api/projects/${projectId}/invites`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: 'brand-new@example.com', role: 'editor' })
      .expect(201);

    assert.equal(inviteRes.body.invite.inviteeEmail, 'brand-new@example.com');
    assert.equal(inviteRes.body.invite.inviteeUserId, undefined);
    assert.equal(inviteRes.body.invite.status, 'pending');

    const { testEmailOutbox } = await import('../src/services/emailService.js');
    assert.equal(testEmailOutbox.projectInvite.length, 1);
    assert.match(testEmailOutbox.projectInviteBodies[0] ?? '', /Create a free QTask account/);

    const notifications = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    assert.equal(
      notifications.body.notifications.some((n: { type: string }) => n.type === 'project_invite'),
      false
    );
  });

  it('exposes public invite preview without auth', async () => {
    const alice = await registerAndVerify('preview-alice@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Preview Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const inviteRes = await request(app)
      .post(`/api/projects/${projectId}/invites`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: 'preview-guest@example.com', role: 'viewer' })
      .expect(201);

    const { testEmailOutbox } = await import('../src/services/emailService.js');
    const token = testEmailOutbox.projectInvite.at(-1);
    assert.ok(token);

    const preview = await request(app).get(`/api/invites/preview/${token}`).expect(200);
    assert.equal(preview.body.invite.projectName, 'Preview Project');
    assert.equal(preview.body.invite.inviteeEmail, 'preview-guest@example.com');
    assert.equal(preview.body.invite.token, undefined);

    await request(app).get('/api/invites/preview/not-a-real-token').expect(404);
  });

  it('lets non-user register and accept invite by email match', async () => {
    const alice = await registerAndVerify('acceptpath-alice@example.com');
    const guestEmail = 'acceptpath-guest@example.com';

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Accept Path Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    await request(app)
      .post(`/api/projects/${projectId}/invites`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: guestEmail, role: 'editor' })
      .expect(201);

    const guest = await registerAndVerify(guestEmail);

    const guestInvites = await request(app)
      .get('/api/invites')
      .set('Authorization', `Bearer ${guest.token}`)
      .expect(200);
    assert.equal(guestInvites.body.invites.length, 1);

    const { testEmailOutbox } = await import('../src/services/emailService.js');
    const inviteToken = testEmailOutbox.projectInvite.at(-1);
    assert.ok(inviteToken);

    const accepted = await request(app)
      .post('/api/invites/accept-by-token')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ token: inviteToken })
      .expect(200);

    assert.equal(accepted.body.invite.status, 'accepted');
    assert.equal(accepted.body.project._id, projectId);
    assert.equal(testEmailOutbox.projectShareAccepted.length, 1);
  });

  it('rejects accept when signed-in email does not match invite', async () => {
    const alice = await registerAndVerify('mismatch-alice@example.com');
    const bob = await registerAndVerify('mismatch-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Mismatch Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const inviteRes = await request(app)
      .post(`/api/projects/${projectId}/invites`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: 'mismatch-guest@example.com', role: 'editor' })
      .expect(201);

    await request(app)
      .post(`/api/invites/${inviteRes.body.invite._id}/accept`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(403);
  });

  it('rejects self-invite by email', async () => {
    const alice = await registerAndVerify('selfinvite-alice@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Self Invite Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    await request(app)
      .post(`/api/projects/${projectId}/invites`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: alice.email, role: 'editor' })
      .expect(400);
  });
});
