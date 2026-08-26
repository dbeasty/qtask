import { after, before, beforeEach, describe, it } from 'node:test';
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
  return { token: login.body.token as string, email, userId: login.body.user.id as string };
}

async function inviteCollaborator(
  ownerToken: string,
  invitee: { token: string; email: string },
  projectId: string,
  role: 'editor' | 'executor' | 'viewer' | 'manager'
) {
  const inviteRes = await request(app)
    .post(`/api/projects/${projectId}/collaborators`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email: invitee.email, role })
    .expect(201);

  await request(app)
    .post(`/api/invites/${inviteRes.body.invite._id}/accept`)
    .set('Authorization', `Bearer ${invitee.token}`)
    .expect(200);
}

async function findProject(token: string, projectId: string) {
  const list = await request(app)
    .get('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return list.body.projects.find((project: { _id: string }) => project._id === projectId);
}

describe('project done override', () => {
  it('forces status/percent to done and clears back to the derived state on undo', async () => {
    const { token } = await registerAndVerify('done-override@example.com');

    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Done Override' })
      .expect(201);
    const projectId = project.body.project._id as string;

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Still open', projectId, status: 'todo', percentComplete: 0 })
      .expect(201);

    const beforeToggle = await findProject(token, projectId);
    assert.equal(beforeToggle.status, 'todo');
    assert.equal(beforeToggle.percentComplete, 0);

    const marked = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ done: true })
      .expect(200);
    assert.equal(marked.body.project.status, 'done');
    assert.equal(marked.body.project.percentComplete, 100);

    const stillDoneAfterGet = await findProject(token, projectId);
    assert.equal(stillDoneAfterGet.status, 'done');
    assert.equal(stillDoneAfterGet.percentComplete, 100);

    const unmarked = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ done: false })
      .expect(200);

    // The override no longer forces done/100 — status recomputes from the
    // still-incomplete task instead of staying pinned at done/100.
    assert.equal(unmarked.body.project.status, 'todo');
    assert.equal(unmarked.body.project.percentComplete, 0);
  });

  it('keeps a parent project pinned to done while overridden, and lets it recompute afterward', async () => {
    const { token } = await registerAndVerify('done-override-parent@example.com');

    const parent = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Parent' })
      .expect(201);
    const parentId = parent.body.project._id as string;

    const child = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Child', parentId })
      .expect(201);
    const childId = child.body.project._id as string;

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Child task', projectId: childId, status: 'todo', percentComplete: 0 })
      .expect(201);

    await request(app)
      .patch(`/api/projects/${parentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ done: true })
      .expect(200);

    const parentWhileOverridden = await findProject(token, parentId);
    assert.equal(parentWhileOverridden.status, 'done');
    assert.equal(parentWhileOverridden.percentComplete, 100);

    // Editing the still-incomplete child recalculates the parent chain; the
    // override should keep pinning the parent at done/100 throughout.
    await request(app)
      .patch(`/api/projects/${childId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Child renamed' })
      .expect(200);

    const parentStillOverridden = await findProject(token, parentId);
    assert.equal(parentStillOverridden.status, 'done');
    assert.equal(parentStillOverridden.percentComplete, 100);

    await request(app)
      .patch(`/api/projects/${parentId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ done: false })
      .expect(200);

    const parentAfterUndo = await findProject(token, parentId);
    assert.notEqual(parentAfterUndo.status, 'done');
  });

  it('lets an executor collaborator toggle done but not rename the project', async () => {
    const owner = await registerAndVerify('done-override-owner@example.com');
    const executor = await registerAndVerify('done-override-executor@example.com');

    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Shared Project' })
      .expect(201);
    const projectId = project.body.project._id as string;

    await inviteCollaborator(owner.token, executor, projectId, 'executor');

    await request(app)
      .patch(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${executor.token}`)
      .send({ done: true })
      .expect(200);

    await request(app)
      .patch(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${executor.token}`)
      .send({ name: 'Renamed by executor' })
      .expect(403);
  });

  it('blocks a viewer collaborator from toggling done', async () => {
    const owner = await registerAndVerify('done-override-owner2@example.com');
    const viewer = await registerAndVerify('done-override-viewer@example.com');

    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Viewer Project' })
      .expect(201);
    const projectId = project.body.project._id as string;

    await inviteCollaborator(owner.token, viewer, projectId, 'viewer');

    await request(app)
      .patch(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({ done: true })
      .expect(403);
  });
});
