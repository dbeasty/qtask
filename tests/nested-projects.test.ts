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
  return { token: login.body.token as string, userId: login.body.user.id as string };
}

describe('nested projects and shared tasks', () => {
  it('nests projects, rejects cycles, and reparents children on delete', async () => {
    const { token } = await registerAndVerify('nest-owner@example.com');

    const parent = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Parent' })
      .expect(201);

    const child = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Child', parentId: parent.body.project._id })
      .expect(201);

    assert.equal(child.body.project.parentId, parent.body.project._id);

    const grandchild = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Grandchild', parentId: child.body.project._id })
      .expect(201);

    await request(app)
      .post(`/api/projects/${parent.body.project._id}/move`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parentId: grandchild.body.project._id })
      .expect(400);

    await request(app)
      .delete(`/api/projects/${child.body.project._id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const remaining = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const moved = remaining.body.projects.find(
      (project: { _id: string }) => project._id === grandchild.body.project._id
    );
    assert.equal(moved.parentId, parent.body.project._id);
  });

  it('supports move, share, unlink, and duplicate across projects', async () => {
    const { token } = await registerAndVerify('share-owner@example.com');

    const alpha = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Alpha' })
      .expect(201);
    const beta = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Beta' })
      .expect(201);

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Shared work', projectId: alpha.body.project._id })
      .expect(201);

    assert.deepEqual(created.body.task.projectIds, [alpha.body.project._id]);

    const shared = await request(app)
      .post(`/api/tasks/${created.body.task._id}/share-project`)
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: beta.body.project._id })
      .expect(200);

    assert.equal(shared.body.task.projectIds.length, 2);

    const inBeta = await request(app)
      .get('/api/tasks')
      .query({ projectId: beta.body.project._id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.ok(inBeta.body.tasks.some((task: { _id: string }) => task._id === created.body.task._id));

    const duplicated = await request(app)
      .post(`/api/tasks/${created.body.task._id}/duplicate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: beta.body.project._id })
      .expect(201);

    assert.notEqual(duplicated.body.task._id, created.body.task._id);
    assert.deepEqual(duplicated.body.task.projectIds, [beta.body.project._id]);

    const moved = await request(app)
      .post(`/api/tasks/${created.body.task._id}/move-project`)
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: beta.body.project._id })
      .expect(200);
    assert.deepEqual(moved.body.task.projectIds, [beta.body.project._id]);

    await request(app)
      .post(`/api/tasks/${moved.body.task._id}/share-project`)
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: alpha.body.project._id })
      .expect(200);

    await request(app)
      .post(`/api/tasks/${moved.body.task._id}/unlink-project`)
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: alpha.body.project._id })
      .expect(200);
  });

  it('deletes sole-membership tasks and unlinks shared tasks when deleting a project', async () => {
    const { token } = await registerAndVerify('delete-owner@example.com');

    const keep = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Keep' })
      .expect(201);
    const drop = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Drop' })
      .expect(201);

    const sole = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Only in drop', projectId: drop.body.project._id })
      .expect(201);

    const shared = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'In both', projectId: keep.body.project._id })
      .expect(201);

    await request(app)
      .post(`/api/tasks/${shared.body.task._id}/share-project`)
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: drop.body.project._id })
      .expect(200);

    const { conversationService } = await import('../src/services/conversationService.js');
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await conversationService.createConversation(
      me.body.user.id,
      'Drop chat',
      drop.body.project._id
    );

    await request(app)
      .delete(`/api/projects/${drop.body.project._id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const soleGet = await request(app)
      .get(`/api/tasks/${sole.body.task._id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    void soleGet;

    const sharedGet = await request(app)
      .get(`/api/tasks/${shared.body.task._id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.deepEqual(sharedGet.body.task.projectIds, [keep.body.project._id]);

    const chats = await request(app)
      .get('/api/conversations')
      .query({ projectId: keep.body.project._id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.ok(
      chats.body.conversations.every(
        (conversation: { title: string }) => conversation.title !== 'Drop chat'
      )
    );
  });

  it('scopes conversations to a project', async () => {
    const { token, userId } = await registerAndVerify('chat-scope@example.com');

    const projects = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const projectA = projects.body.projects[0];
    const projectB = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Other chat project' })
      .expect(201);

    const { conversationService } = await import('../src/services/conversationService.js');

    await conversationService.createConversation(userId, 'A chat', projectA._id);
    await conversationService.createConversation(userId, 'B chat', projectB.body.project._id);

    const listedA = await request(app)
      .get('/api/conversations')
      .query({ projectId: projectA._id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.equal(listedA.body.conversations.length, 1);
    assert.equal(listedA.body.conversations[0].title, 'A chat');

    const listedB = await request(app)
      .get('/api/conversations')
      .query({ projectId: projectB.body.project._id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.equal(listedB.body.conversations.length, 1);
    assert.equal(listedB.body.conversations[0].title, 'B chat');
  });
});
