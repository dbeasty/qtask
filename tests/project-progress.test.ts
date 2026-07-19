import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import {
  computeLeafProjectProgress,
  computeParentProjectProgress,
} from '../src/utils/projectProgress.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';

describe('projectProgress helpers', () => {
  it('averages leaf task percents and syncs status', () => {
    const result = computeLeafProjectProgress([
      { status: 'done', percentComplete: 100 },
      { status: 'todo', percentComplete: 0 },
    ]);
    assert.equal(result.percentComplete, 50);
    assert.equal(result.status, 'in_progress');
  });

  it('marks leaf done when all tasks are done', () => {
    const result = computeLeafProjectProgress([
      { status: 'done', percentComplete: 100 },
      { status: 'done', percentComplete: 100 },
    ]);
    assert.equal(result.percentComplete, 100);
    assert.equal(result.status, 'done');
  });

  it('weights parent rollup by progressShare', () => {
    const result = computeParentProjectProgress([
      { status: 'done', percentComplete: 100, progressShare: 25 },
      { status: 'todo', percentComplete: 0, progressShare: 75 },
    ]);
    assert.equal(result.percentComplete, 25);
    assert.equal(result.status, 'in_progress');
  });
});

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

async function findProject(token: string, projectId: string) {
  const list = await request(app)
    .get('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return list.body.projects.find((project: { _id: string }) => project._id === projectId);
}

describe('project status rollup', () => {
  it('derives leaf percent and status from linked tasks', async () => {
    const { token } = await registerAndVerify('leaf-progress@example.com');

    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Leaf' })
      .expect(201);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'A',
        projectId: project.body.project._id,
        status: 'done',
        percentComplete: 100,
      })
      .expect(201);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'B',
        projectId: project.body.project._id,
        status: 'todo',
        percentComplete: 0,
      })
      .expect(201);

    const refreshed = await findProject(token, project.body.project._id);
    assert.equal(refreshed.percentComplete, 50);
    assert.equal(refreshed.status, 'in_progress');
  });

  it('rolls up weighted child progressShare to parents', async () => {
    const { token } = await registerAndVerify('weighted-parent@example.com');

    const parent = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Parent' })
      .expect(201);

    const heavy = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Heavy', parentId: parent.body.project._id })
      .expect(201);

    const light = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Light', parentId: parent.body.project._id })
      .expect(201);

    await request(app)
      .patch(`/api/projects/${heavy.body.project._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ progressShare: 75 })
      .expect(200);

    await request(app)
      .patch(`/api/projects/${light.body.project._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ progressShare: 25 })
      .expect(200);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Heavy done',
        projectId: heavy.body.project._id,
        status: 'done',
        percentComplete: 100,
      })
      .expect(201);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Light todo',
        projectId: light.body.project._id,
        status: 'todo',
        percentComplete: 0,
      })
      .expect(201);

    const heavyProject = await findProject(token, heavy.body.project._id);
    const lightProject = await findProject(token, light.body.project._id);
    const parentProject = await findProject(token, parent.body.project._id);

    assert.equal(heavyProject.percentComplete, 100);
    assert.equal(heavyProject.status, 'done');
    assert.equal(lightProject.percentComplete, 0);
    assert.equal(parentProject.percentComplete, 75);
    assert.equal(parentProject.status, 'in_progress');
  });

  it('refreshes leaf and ancestors when a task progress changes', async () => {
    const { token } = await registerAndVerify('task-refresh@example.com');

    const parent = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Parent refresh' })
      .expect(201);

    const child = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Child refresh', parentId: parent.body.project._id })
      .expect(201);

    const task = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Progressing',
        projectId: child.body.project._id,
        status: 'todo',
        percentComplete: 0,
      })
      .expect(201);

    let childProject = await findProject(token, child.body.project._id);
    let parentProject = await findProject(token, parent.body.project._id);
    assert.equal(childProject.percentComplete, 0);
    assert.equal(parentProject.percentComplete, 0);

    await request(app)
      .patch(`/api/tasks/${task.body.task._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'done', percentComplete: 100 })
      .expect(200);

    childProject = await findProject(token, child.body.project._id);
    parentProject = await findProject(token, parent.body.project._id);
    assert.equal(childProject.percentComplete, 100);
    assert.equal(childProject.status, 'done');
    assert.equal(parentProject.percentComplete, 100);
    assert.equal(parentProject.status, 'done');
  });

  it('recalculates when nesting changes and ignores parent direct tasks', async () => {
    const { token } = await registerAndVerify('nest-recalc@example.com');

    const parent = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Parent ignore tasks' })
      .expect(201);

    const child = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Child only' })
      .expect(201);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'On parent',
        projectId: parent.body.project._id,
        status: 'done',
        percentComplete: 100,
      })
      .expect(201);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'On child',
        projectId: child.body.project._id,
        status: 'todo',
        percentComplete: 0,
      })
      .expect(201);

    let parentProject = await findProject(token, parent.body.project._id);
    assert.equal(parentProject.percentComplete, 100);

    await request(app)
      .post(`/api/projects/${child.body.project._id}/move`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parentId: parent.body.project._id })
      .expect(200);

    parentProject = await findProject(token, parent.body.project._id);
    const childProject = await findProject(token, child.body.project._id);

    // Parent now has a child, so direct tasks are ignored; child is 0%.
    assert.equal(childProject.percentComplete, 0);
    assert.equal(parentProject.percentComplete, 0);
    assert.equal(parentProject.status, 'todo');
  });
});
