import { after, before, beforeEach, describe, it } from 'node:test';
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
  return { token: login.body.token as string };
}

async function createProject(token: string, name: string) {
  const res = await request(app)
    .post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name })
    .expect(201);
  return res.body.project._id as string;
}

const RICH_SUBTASK = {
  title: 'Rich subtask',
  steps: [{ text: 'Do the thing' }],
  materials: [{ description: 'Lumber', quantity: 2, unitPrice: 10 }],
  laborLines: [{ description: 'Cutting', hours: 3 }],
  hourlyRate: 25,
};

function assertRichFieldsPreserved(node: {
  steps?: Array<{ text: string }>;
  materials?: Array<{ description: string }>;
  laborLines?: Array<{ description?: string; hours: number }>;
  hourlyRate?: number;
}) {
  assert.equal(node.steps?.length, 1);
  assert.equal(node.steps?.[0]?.text, 'Do the thing');
  assert.equal(node.materials?.length, 1);
  assert.equal(node.materials?.[0]?.description, 'Lumber');
  assert.equal(node.laborLines?.length, 1);
  assert.equal(node.laborLines?.[0]?.hours, 3);
  assert.equal(node.hourlyRate, 25);
}

describe('checklist/cost fields survive subtask promote/attach/delete/duplicate', () => {
  it('promoteSubtaskToTask keeps steps, materials, laborLines, hourlyRate', async () => {
    const { token } = await registerAndVerify('promote-fields@example.com');
    const projectId = await createProject(token, 'Promote Fields');

    const parent = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Parent', projectId, subtasks: [RICH_SUBTASK] })
      .expect(201);
    const taskId = parent.body.task._id as string;
    const subtaskId = parent.body.task.subtasks[0]._id as string;

    const promoted = await request(app)
      .post(`/api/tasks/${taskId}/subtasks/promote?path=${subtaskId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assertRichFieldsPreserved(promoted.body.promotedTask);
  });

  it('attachTaskAsSubtask keeps steps, materials, laborLines, hourlyRate on the new subtask root', async () => {
    const { token } = await registerAndVerify('attach-fields@example.com');
    const projectId = await createProject(token, 'Attach Fields');

    const target = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Target', projectId })
      .expect(201);
    const targetId = target.body.task._id as string;

    const source = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...RICH_SUBTASK, title: 'Source', projectId })
      .expect(201);
    const sourceId = source.body.task._id as string;

    await request(app)
      .post(`/api/tasks/${targetId}/subtasks/attach-task`)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceTaskId: sourceId, parentPath: [] })
      .expect(200);

    const refreshed = await request(app)
      .get(`/api/tasks/${targetId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assertRichFieldsPreserved(refreshed.body.task.subtasks[0]);
  });

  it('deleteTask with keepChildren keeps steps on promoted children', async () => {
    const { token } = await registerAndVerify('delete-keep-fields@example.com');
    const projectId = await createProject(token, 'Delete Keep Fields');

    const parent = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Parent', projectId, subtasks: [RICH_SUBTASK] })
      .expect(201);
    const taskId = parent.body.task._id as string;

    const result = await request(app)
      .delete(`/api/tasks/${taskId}?keepChildren=true`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assertRichFieldsPreserved(result.body.promotedTasks[0]);
  });

  it('duplicateTask keeps steps, materials, laborLines, hourlyRate', async () => {
    const { token } = await registerAndVerify('duplicate-fields@example.com');
    const projectId = await createProject(token, 'Duplicate Fields');

    const original = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...RICH_SUBTASK, title: 'Original', projectId })
      .expect(201);
    const originalId = original.body.task._id as string;

    const duplicated = await request(app)
      .post(`/api/tasks/${originalId}/duplicate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId })
      .expect(201);

    assertRichFieldsPreserved(duplicated.body.task);
  });
});

describe('comments are cleaned up, not orphaned', () => {
  it('deleteTask with keepChildren removes the deleted parent task\'s comments', async () => {
    const { token } = await registerAndVerify('delete-keep-comments@example.com');
    const projectId = await createProject(token, 'Delete Keep Comments');

    const parent = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Parent', projectId, subtasks: [{ title: 'Child' }] })
      .expect(201);
    const taskId = parent.body.task._id as string;

    await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'On the parent' })
      .expect(201);

    await request(app)
      .delete(`/api/tasks/${taskId}?keepChildren=true`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const { CommentModel } = await import('../src/models/index.js');
    const remaining = await CommentModel.countDocuments({ taskId });
    assert.equal(remaining, 0);
  });

  it('attachTaskAsSubtask removes the absorbed source task\'s comments', async () => {
    const { token } = await registerAndVerify('attach-comments@example.com');
    const projectId = await createProject(token, 'Attach Comments');

    const target = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Target', projectId })
      .expect(201);
    const targetId = target.body.task._id as string;

    const source = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Source', projectId })
      .expect(201);
    const sourceId = source.body.task._id as string;

    await request(app)
      .post(`/api/tasks/${sourceId}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'On the source' })
      .expect(201);

    await request(app)
      .post(`/api/tasks/${targetId}/subtasks/attach-task`)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceTaskId: sourceId, parentPath: [] })
      .expect(200);

    const { CommentModel } = await import('../src/models/index.js');
    const remaining = await CommentModel.countDocuments({ taskId: sourceId });
    assert.equal(remaining, 0);
  });
});
