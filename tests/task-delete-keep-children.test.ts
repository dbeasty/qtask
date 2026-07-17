import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-keep-children';
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

async function createProject(token: string, name: string) {
  const res = await request(app)
    .post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name })
    .expect(201);
  return res.body.project._id as string;
}

type NestedSubtask = {
  _id: string;
  title: string;
  subtasks: NestedSubtask[];
};

describe('delete keep children', () => {
  it('recursively deletes a task and its subtasks by default', async () => {
    const user = await registerAndVerify('delete-all@example.com');
    const projectId = await createProject(user.token, 'Delete All');

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        title: 'Parent',
        projectId,
        subtasks: [{ title: 'Child A', subtasks: [{ title: 'Grandchild' }] }, { title: 'Child B' }],
      })
      .expect(201);

    const taskId = created.body.task._id as string;

    await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(204);

    const list = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    assert.equal(
      list.body.tasks.some((task: { _id: string }) => task._id === taskId),
      false
    );
    assert.equal(
      list.body.tasks.some((task: { title: string }) => task.title === 'Child A'),
      false
    );
  });

  it('promotes direct children to top-level tasks when keepChildren is set', async () => {
    const user = await registerAndVerify('keep-top@example.com');
    const projectId = await createProject(user.token, 'Keep Top');

    const beforeSibling = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'Before', projectId })
      .expect(201);

    const parent = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        title: 'Parent',
        projectId,
        subtasks: [
          { title: 'Child A', subtasks: [{ title: 'Nested under A' }] },
          { title: 'Child B' },
        ],
      })
      .expect(201);

    const afterSibling = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'After', projectId })
      .expect(201);

    // Put Parent between Before and After by reorder.
    await request(app)
      .post(`/api/projects/${projectId}/tasks/reorder`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ taskId: beforeSibling.body.task._id, index: 0 })
      .expect(200);
    await request(app)
      .post(`/api/projects/${projectId}/tasks/reorder`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ taskId: parent.body.task._id, index: 1 })
      .expect(200);
    await request(app)
      .post(`/api/projects/${projectId}/tasks/reorder`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ taskId: afterSibling.body.task._id, index: 2 })
      .expect(200);

    const deleted = await request(app)
      .delete(`/api/tasks/${parent.body.task._id}?keepChildren=true`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    const promoted = deleted.body.promotedTasks as Array<{
      _id: string;
      title: string;
      projectId: string;
      subtasks: NestedSubtask[];
    }>;
    assert.equal(promoted.length, 2);
    assert.deepEqual(
      promoted.map((task) => task.title),
      ['Child A', 'Child B']
    );
    assert.equal(promoted[0]!.projectId, projectId);
    assert.equal(promoted[0]!.subtasks[0]?.title, 'Nested under A');

    const list = await request(app)
      .get(`/api/tasks?projectId=${projectId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    const titles = (list.body.tasks as Array<{ title: string }>).map((task) => task.title);
    assert.equal(titles.includes('Parent'), false);
    assert.ok(titles.includes('Child A'));
    assert.ok(titles.includes('Child B'));
    assert.ok(titles.includes('Before'));
    assert.ok(titles.includes('After'));

    const childA = (list.body.tasks as Array<{ title: string; subtasks: NestedSubtask[] }>).find(
      (task) => task.title === 'Child A'
    );
    assert.ok(childA);
    assert.equal(childA.subtasks[0]?.title, 'Nested under A');
  });

  it('moves nested subtask children up one level when keepChildren is set', async () => {
    const user = await registerAndVerify('keep-nested@example.com');
    const projectId = await createProject(user.token, 'Keep Nested');

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        title: 'Root',
        projectId,
        subtasks: [
          { title: 'Sibling before' },
          {
            title: 'Middle parent',
            subtasks: [
              { title: 'Keep me A', subtasks: [{ title: 'Deeper' }] },
              { title: 'Keep me B' },
            ],
          },
          { title: 'Sibling after' },
        ],
      })
      .expect(201);

    const task = created.body.task as { _id: string; subtasks: NestedSubtask[] };
    const middle = task.subtasks[1]!;
    assert.equal(middle.title, 'Middle parent');

    const updated = await request(app)
      .delete(`/api/tasks/${task._id}/subtasks?path=${middle._id}&keepChildren=true`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    const subtasks = updated.body.task.subtasks as NestedSubtask[];
    assert.deepEqual(
      subtasks.map((item) => item.title),
      ['Sibling before', 'Keep me A', 'Keep me B', 'Sibling after']
    );
    assert.equal(subtasks[1]!.subtasks[0]?.title, 'Deeper');
    assert.equal(
      subtasks.some((item) => item.title === 'Middle parent'),
      false
    );
  });

  it('deletes a leaf subtask without keepChildren behavior', async () => {
    const user = await registerAndVerify('delete-leaf@example.com');
    const projectId = await createProject(user.token, 'Delete Leaf');

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        title: 'Root',
        projectId,
        subtasks: [{ title: 'Only child' }],
      })
      .expect(201);

    const taskId = created.body.task._id as string;
    const childId = created.body.task.subtasks[0]._id as string;

    const deleted = await request(app)
      .delete(`/api/tasks/${taskId}/subtasks?path=${childId}&keepChildren=true`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    assert.equal(deleted.body.task.subtasks.length, 0);
  });

  it('returns 404 for missing task ids', async () => {
    const user = await registerAndVerify('missing-delete@example.com');
    const missingId = new mongoose.Types.ObjectId().toString();

    await request(app)
      .delete(`/api/tasks/${missingId}?keepChildren=true`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(404);

    await request(app)
      .delete(`/api/tasks/${missingId}/subtasks?path=${missingId}&keepChildren=true`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(404);
  });

  it('rejects keepChildren delete for viewers', async () => {
    const alice = await registerAndVerify('keep-alice@example.com');
    const bob = await registerAndVerify('keep-bob@example.com');
    const projectId = await createProject(alice.token, 'Shared Keep');

    const task = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        title: 'Shared parent',
        projectId,
        subtasks: [{ title: 'Shared child' }],
      })
      .expect(201);

    await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: bob.email, role: 'viewer' })
      .expect(201);

    await request(app)
      .delete(`/api/tasks/${task.body.task._id}?keepChildren=true`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(403);
  });

  it('deletes an owned task whose projectId is orphaned/invalid without a 500', async () => {
    const user = await registerAndVerify('orphan-delete@example.com');
    const { TaskModel } = await import('../src/models/index.js');

    const task = await TaskModel.create({
      userId: user.userId,
      projectId: 'Get the boat set on trailer',
      title: 'Orphaned parent',
      subtasks: [{ title: 'Orphaned child' }],
    });

    await request(app)
      .delete(`/api/tasks/${String(task._id)}`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(204);

    const fetched = await TaskModel.findById(task._id).lean();
    assert.equal(fetched, null);
  });

  it('promotes children into the default project when the parent projectId is invalid', async () => {
    const user = await registerAndVerify('orphan-keep@example.com');
    const { TaskModel } = await import('../src/models/index.js');

    const task = await TaskModel.create({
      userId: user.userId,
      projectId: 'not-a-real-object-id',
      title: 'Orphaned parent',
      subtasks: [{ title: 'Child A', subtasks: [{ title: 'Grandchild' }] }, { title: 'Child B' }],
    });

    const deleted = await request(app)
      .delete(`/api/tasks/${String(task._id)}?keepChildren=true`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    const promoted = deleted.body.promotedTasks as Array<{
      _id: string;
      title: string;
      projectId: string;
      subtasks: NestedSubtask[];
    }>;
    assert.equal(promoted.length, 2);
    assert.deepEqual(
      promoted.map((item) => item.title),
      ['Child A', 'Child B']
    );
    for (const item of promoted) {
      assert.match(item.projectId, /^[0-9a-f]{24}$/);
    }
    assert.equal(promoted[0]!.subtasks[0]?.title, 'Grandchild');

    // The promoted tasks are now listable without triggering a cast error.
    const list = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    const titles = (list.body.tasks as Array<{ title: string }>).map((item) => item.title);
    assert.ok(titles.includes('Child A'));
    assert.ok(titles.includes('Child B'));
    assert.equal(titles.includes('Orphaned parent'), false);
  });

  it('returns 404 instead of 500 when filtering tasks by an invalid projectId', async () => {
    const user = await registerAndVerify('invalid-filter@example.com');

    await request(app)
      .get('/api/tasks?projectId=Get the boat set on trailer')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(404);
  });
});
