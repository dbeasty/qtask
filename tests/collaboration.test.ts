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

describe('project collaboration', () => {
  it('keeps non-members isolated from projects and tasks', async () => {
    const alice = await registerAndVerify('collab-alice@example.com');
    const bob = await registerAndVerify('collab-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Alice Shared' })
      .expect(201);

    const projectId = projectRes.body.project._id as string;

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Secret task', projectId })
      .expect(201);

    await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(404);

    const bobProjects = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    assert.equal(
      bobProjects.body.projects.some((p: { _id: string }) => p._id === projectId),
      false
    );

    const bobTasks = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    assert.equal(
      bobTasks.body.tasks.some((t: { title: string }) => t.title === 'Secret task'),
      false
    );
  });

  it('lets an editor collaborator list, read, and mutate shared tasks', async () => {
    const alice = await registerAndVerify('editor-alice@example.com');
    const bob = await registerAndVerify('editor-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Team Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Shared task', projectId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    const added = await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: bob.email, role: 'editor' })
      .expect(201);

    assert.equal(added.body.project.collaborators.length, 1);
    assert.equal(added.body.project.collaborators[0].email, bob.email);
    assert.equal(added.body.project.collaborators[0].role, 'editor');

    const bobProjects = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    const shared = bobProjects.body.projects.find((p: { _id: string }) => p._id === projectId);
    assert.ok(shared);
    assert.equal(shared.role, 'editor');
    assert.equal(shared.canEdit, true);
    assert.equal(shared.canUpdateStatus, true);
    assert.equal(shared.canManageMembers, false);

    const bobTask = await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(bobTask.body.task.title, 'Shared task');

    const updated = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Updated by Bob' })
      .expect(200);
    assert.equal(updated.body.task.title, 'Updated by Bob');

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Bob created', projectId })
      .expect(201);
    assert.equal(created.body.task.projectId, projectId);

    const aliceTasks = await request(app)
      .get('/api/tasks')
      .query({ projectId })
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    assert.ok(aliceTasks.body.tasks.some((t: { title: string }) => t.title === 'Bob created'));
  });

  it('blocks viewers from mutating and blocks collaborators from managing members', async () => {
    const alice = await registerAndVerify('viewer-alice@example.com');
    const bob = await registerAndVerify('viewer-bob@example.com');
    const carol = await registerAndVerify('viewer-carol@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Read Only' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'View me', projectId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: bob.email, role: 'viewer' })
      .expect(201);

    await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Nope' })
      .expect(403);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Nope create', projectId })
      .expect(403);

    await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ email: carol.email, role: 'editor' })
      .expect(403);

    await request(app)
      .delete(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(403);
  });

  it('allows role updates, self-leave, and removes access afterward', async () => {
    const alice = await registerAndVerify('leave-alice@example.com');
    const bob = await registerAndVerify('leave-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Leave Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: 'Leave-Bob@example.com', role: 'executor' })
      .expect(201);

    const roleUpdated = await request(app)
      .patch(`/api/projects/${projectId}/collaborators/${bob.userId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ role: 'editor' })
      .expect(200);
    assert.equal(roleUpdated.body.project.collaborators[0].role, 'editor');

    const left = await request(app)
      .delete(`/api/projects/${projectId}/collaborators/${bob.userId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(left.body.left, true);

    await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(404);
  });

  it('lets an executor update status but not other task fields', async () => {
    const alice = await registerAndVerify('executor-alice@example.com');
    const bob = await registerAndVerify('executor-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Executor Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Do the work', projectId, status: 'todo' })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: bob.email, role: 'executor' })
      .expect(201);

    const bobProjects = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    const shared = bobProjects.body.projects.find((p: { _id: string }) => p._id === projectId);
    assert.ok(shared);
    assert.equal(shared.role, 'executor');
    assert.equal(shared.canEdit, false);
    assert.equal(shared.canUpdateStatus, true);

    const statusUpdated = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ status: 'in_progress' })
      .expect(200);
    assert.equal(statusUpdated.body.task.status, 'in_progress');

    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Nope' })
      .expect(403);

    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ status: 'done', title: 'Nope' })
      .expect(403);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Nope create', projectId })
      .expect(403);

    await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(403);
  });

  it('blocks viewers from updating status', async () => {
    const alice = await registerAndVerify('viewer-status-alice@example.com');
    const bob = await registerAndVerify('viewer-status-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Viewer Status' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Stay todo', projectId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: bob.email, role: 'viewer' })
      .expect(201);

    const bobProjects = await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(bobProjects.body.project.canUpdateStatus, false);

    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ status: 'done' })
      .expect(403);
  });

  it('rejects adding unknown users and cannot remove the owner', async () => {
    const alice = await registerAndVerify('owner-alice@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Owner Guards' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: 'missing@example.com', role: 'editor' })
      .expect(404);

    await request(app)
      .delete(`/api/projects/${projectId}/collaborators/${alice.userId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(400);
  });
});
