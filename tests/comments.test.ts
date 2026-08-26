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
  await mongoose.connection.dropDatabase();
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

async function inviteCollaborator(
  ownerToken: string,
  invitee: { token: string; email: string },
  projectId: string,
  role: 'editor' | 'executor' | 'viewer' | 'manager' = 'editor'
) {
  const inviteRes = await request(app)
    .post(`/api/projects/${projectId}/collaborators`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email: invitee.email, role })
    .expect(201);

  const inviteId = inviteRes.body.invite._id as string;
  await request(app)
    .post(`/api/invites/${inviteId}/accept`)
    .set('Authorization', `Bearer ${invitee.token}`)
    .expect(200);
}

describe('task comments', () => {
  it('enforces role-based access and scopes comments to task or subtask', async () => {
    const alice = await registerAndVerify('comments-alice@example.com');
    const bob = await registerAndVerify('comments-bob@example.com');
    const carol = await registerAndVerify('comments-carol@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Comments Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Root task', projectId, assigneeId: bob.userId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    const subtaskRes = await request(app)
      .post(`/api/tasks/${taskId}/subtasks`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Nested subtask' })
      .expect(201);
    const subtaskId = subtaskRes.body.task.subtasks[0]._id as string;

    await inviteCollaborator(alice.token, bob, projectId, 'executor');
    await inviteCollaborator(alice.token, carol, projectId, 'viewer');

    await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${carol.token}`)
      .send({ body: 'Viewer cannot post' })
      .expect(403);

    await request(app)
      .get(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${carol.token}`)
      .expect(200);

    const bobComment = await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ body: 'Executor comment on root' })
      .expect(201);
    assert.equal(bobComment.body.comment.body, 'Executor comment on root');

    const subtaskComment = await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ body: 'Subtask scoped', subtaskPath: [subtaskId] })
      .expect(201);
    assert.deepEqual(subtaskComment.body.comment.subtaskPath, [subtaskId]);

    const rootOnly = await request(app)
      .get(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(rootOnly.body.comments.length, 1);

    const subtaskOnly = await request(app)
      .get(`/api/tasks/${taskId}/comments?subtaskPath=${subtaskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(subtaskOnly.body.comments.length, 1);
    assert.equal(subtaskOnly.body.comments[0].body, 'Subtask scoped');

    await request(app)
      .get(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    const outsider = await registerAndVerify('comments-outsider@example.com');
    await request(app)
      .get(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .expect(404);
  });

  it('supports edit, delete permissions, threading, and activity logging', async () => {
    const alice = await registerAndVerify('comments-edit-alice@example.com');
    const bob = await registerAndVerify('comments-edit-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Edit Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Thread task', projectId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await inviteCollaborator(alice.token, bob, projectId, 'executor');

    const parent = await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ body: 'Parent comment' })
      .expect(201);
    const parentId = parent.body.comment._id as string;

    const reply = await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ body: 'Reply comment', parentId })
      .expect(201);
    assert.equal(reply.body.comment.parentId, parentId);

    const listed = await request(app)
      .get(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    assert.equal(listed.body.comments.length, 2);

    await request(app)
      .patch(`/api/tasks/${taskId}/comments/${parentId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ body: 'Nope' })
      .expect(403);

    const updated = await request(app)
      .patch(`/api/tasks/${taskId}/comments/${parentId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ body: 'Updated parent' })
      .expect(200);
    assert.equal(updated.body.comment.body, 'Updated parent');
    assert.ok(updated.body.comment.editedAt);

    await request(app)
      .delete(`/api/tasks/${taskId}/comments/${parentId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(204);

    const afterDelete = await request(app)
      .get(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    assert.equal(afterDelete.body.comments.length, 0);

    const activity = await request(app)
      .get(`/api/tasks/${taskId}/activity`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const actions = activity.body.activity.map((entry: { action: string }) => entry.action);
    assert.ok(actions.includes('comment.added'));
    assert.ok(actions.includes('comment.updated'));
    assert.ok(actions.includes('comment.deleted'));
  });

  it('creates in-app notifications and optional email delivery', async () => {
    const alice = await registerAndVerify('comments-notify-alice@example.com');
    const bob = await registerAndVerify('comments-notify-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Notify Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Notify task', projectId, assigneeId: bob.userId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await inviteCollaborator(alice.token, bob, projectId, 'executor');

    await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ body: 'In-app only', notifyByEmail: false })
      .expect(201);

    const { testEmailOutbox } = await import('../src/services/emailService.js');
    assert.equal(testEmailOutbox.commentNotification.length, 0);

    const aliceNotifications = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    assert.ok(
      aliceNotifications.body.notifications.some(
        (n: { type: string }) => n.type === 'task_comment'
      )
    );

    await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ body: 'Email me', notifyByEmail: true })
      .expect(201);

    assert.ok(testEmailOutbox.commentNotification.length > 0);
  });

  it('includes comments in get_task agent tool output', async () => {
    const alice = await registerAndVerify('comments-agent-alice@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Agent Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Agent task', projectId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ body: 'Agent-visible comment' })
      .expect(201);

    const { executeTool } = await import('../src/agent/tools.js');
    const result = await executeTool('get_task', { taskId }, alice.userId, { source: 'agent' });
    assert.equal(result.success, true);
    const payload = JSON.parse(result.text);
    assert.equal(payload.comments.length, 1);
    assert.equal(payload.comments[0].body, 'Agent-visible comment');
  });

  it('includes comment text in task embedding input', async () => {
    const { buildTaskEmbeddingText } = await import('../src/services/embeddingService.js');
    const text = buildTaskEmbeddingText({
      title: 'Launch',
      comments: [{ authorLabel: 'Alice', body: 'Blocked on API review' }],
    });
    assert.match(text, /Comments:/);
    assert.match(text, /Blocked on API review/);
  });

  it('deletes comments when the task is deleted and enqueues embedding jobs', async () => {
    const alice = await registerAndVerify('comments-delete-alice@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Delete Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Delete me', projectId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ body: 'Will be deleted' })
      .expect(201);

    const { EmbeddingJobModel, CommentModel } = await import('../src/models/index.js');
    let job = await EmbeddingJobModel.findOne({ entityId: taskId }).lean();
    assert.ok(job);

    await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(204);

    const remaining = await CommentModel.countDocuments({ taskId });
    assert.equal(remaining, 0);

    job = await EmbeddingJobModel.findOne({ entityId: taskId }).lean();
    assert.equal(job?.status, 'pending');
  });

  it('rejects invalid subtask paths', async () => {
    const alice = await registerAndVerify('comments-invalid-alice@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Invalid Path Project' })
      .expect(201);

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Task', projectId: projectRes.body.project._id })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ body: 'Bad path', subtaskPath: ['000000000000000000000000'] })
      .expect(400);
  });
});
