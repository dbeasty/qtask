import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { registerUser } from './helpers/mcp.js';

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

after(async () => {
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

async function newUser() {
  return registerUser(`links-${randomUUID()}@example.com`);
}

async function createTask(jwt: string, title: string): Promise<string> {
  const res = await request(app)
    .post('/api/tasks')
    .set('Authorization', `Bearer ${jwt}`)
    .send({ title })
    .expect(201);
  return res.body.task._id as string;
}

async function addSubtask(jwt: string, taskId: string, title: string, parentPath: string[] = []) {
  const query = parentPath.length ? `?path=${parentPath.join(',')}` : '';
  const res = await request(app)
    .post(`/api/tasks/${taskId}/subtasks${query}`)
    .set('Authorization', `Bearer ${jwt}`)
    .send({ title })
    .expect(201);
  return res.body.task;
}

describe('POST /api/tasks/:id/links', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app).post(`/api/tasks/${new mongoose.Types.ObjectId()}/links`).expect(401);
  });

  it('creates a link of each supported type', async () => {
    for (const type of ['related', 'blocking', 'blocked_by'] as const) {
      const { jwt } = await newUser();
      const a = await createTask(jwt, `A ${type}`);
      const b = await createTask(jwt, `B ${type}`);

      const res = await request(app)
        .post(`/api/tasks/${a}/links`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ linkedTaskId: b, type })
        .expect(200);

      assert.deepEqual(
        res.body.task.links.map((l: { taskId: string; type: string }) => ({
          taskId: l.taskId,
          type: l.type,
        })),
        [{ taskId: b, type }]
      );
    }
  });

  it('is idempotent for the same (task, type) pair', async () => {
    const { jwt } = await newUser();
    const a = await createTask(jwt, 'A');
    const b = await createTask(jwt, 'B');

    await request(app)
      .post(`/api/tasks/${a}/links`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ linkedTaskId: b, type: 'related' })
      .expect(200);

    const second = await request(app)
      .post(`/api/tasks/${a}/links`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ linkedTaskId: b, type: 'related' })
      .expect(200);

    assert.equal(second.body.task.links.length, 1, 'duplicate link must not be appended twice');
  });

  it('allows two different link types to the same task', async () => {
    const { jwt } = await newUser();
    const a = await createTask(jwt, 'A');
    const b = await createTask(jwt, 'B');

    await request(app)
      .post(`/api/tasks/${a}/links`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ linkedTaskId: b, type: 'related' })
      .expect(200);

    const res = await request(app)
      .post(`/api/tasks/${a}/links`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ linkedTaskId: b, type: 'blocking' })
      .expect(200);

    assert.equal(res.body.task.links.length, 2);
  });

  it('rejects a body missing linkedTaskId or type with 400', async () => {
    const { jwt } = await newUser();
    const a = await createTask(jwt, 'A');
    const b = await createTask(jwt, 'B');

    await request(app)
      .post(`/api/tasks/${a}/links`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ type: 'related' })
      .expect(400);

    await request(app)
      .post(`/api/tasks/${a}/links`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ linkedTaskId: b })
      .expect(400);
  });

  it('returns 404 when the linked task belongs to someone else', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const mine = await createTask(owner.jwt, 'Mine');
    const theirs = await createTask(stranger.jwt, 'Theirs');

    await request(app)
      .post(`/api/tasks/${mine}/links`)
      .set('Authorization', `Bearer ${owner.jwt}`)
      .send({ linkedTaskId: theirs, type: 'related' })
      .expect(404);
  });

  it('returns 404 when the target task is not accessible', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const theirs = await createTask(stranger.jwt, 'Theirs');
    const alsoTheirs = await createTask(stranger.jwt, 'Theirs 2');

    await request(app)
      .post(`/api/tasks/${theirs}/links`)
      .set('Authorization', `Bearer ${owner.jwt}`)
      .send({ linkedTaskId: alsoTheirs, type: 'related' })
      .expect(404);
  });
});

describe('DELETE /api/tasks/:id/links/:linkedTaskId/:type', () => {
  it('removes only the matching link type', async () => {
    const { jwt } = await newUser();
    const a = await createTask(jwt, 'A');
    const b = await createTask(jwt, 'B');

    for (const type of ['related', 'blocking'] as const) {
      await request(app)
        .post(`/api/tasks/${a}/links`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ linkedTaskId: b, type })
        .expect(200);
    }

    const res = await request(app)
      .delete(`/api/tasks/${a}/links/${b}/related`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.deepEqual(
      res.body.task.links.map((l: { type: string }) => l.type),
      ['blocking'],
      'only the "related" link should have been removed'
    );
  });

  it('is a no-op for a link that does not exist', async () => {
    const { jwt } = await newUser();
    const a = await createTask(jwt, 'A');
    const b = await createTask(jwt, 'B');

    const res = await request(app)
      .delete(`/api/tasks/${a}/links/${b}/related`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.deepEqual(res.body.task.links, []);
  });

  it('returns 404 for a task the caller cannot reach', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const theirs = await createTask(stranger.jwt, 'Theirs');

    await request(app)
      .delete(`/api/tasks/${theirs}/links/${new mongoose.Types.ObjectId()}/related`)
      .set('Authorization', `Bearer ${owner.jwt}`)
      .expect(404);
  });
});

describe('POST /api/tasks/:id/subtasks/move', () => {
  it('reorders a subtask within the same parent', async () => {
    const { jwt } = await newUser();
    const taskId = await createTask(jwt, 'Root');
    await addSubtask(jwt, taskId, 'first');
    await addSubtask(jwt, taskId, 'second');
    const afterThird = await addSubtask(jwt, taskId, 'third');

    const ids = afterThird.subtasks.map((s: { _id: string }) => s._id);
    assert.equal(afterThird.subtasks.length, 3);

    // move the last one to the front
    const res = await request(app)
      .post(`/api/tasks/${taskId}/subtasks/move`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ fromPath: [ids[2]], toParentPath: [], index: 0 })
      .expect(200);

    assert.deepEqual(
      res.body.task.subtasks.map((s: { title: string }) => s.title),
      ['third', 'first', 'second']
    );
  });

  it('reparents a subtask under a sibling', async () => {
    const { jwt } = await newUser();
    const taskId = await createTask(jwt, 'Root');
    await addSubtask(jwt, taskId, 'parent');
    const after = await addSubtask(jwt, taskId, 'child');

    const parentId = after.subtasks[0]._id as string;
    const childId = after.subtasks[1]._id as string;

    const res = await request(app)
      .post(`/api/tasks/${taskId}/subtasks/move`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ fromPath: [childId], toParentPath: [parentId] })
      .expect(200);

    assert.equal(res.body.task.subtasks.length, 1, 'child must leave the root level');
    assert.equal(res.body.task.subtasks[0].subtasks.length, 1);
    assert.equal(res.body.task.subtasks[0].subtasks[0].title, 'child');
  });

  it('refuses to move a subtask into its own descendant', async () => {
    const { jwt } = await newUser();
    const taskId = await createTask(jwt, 'Root');
    await addSubtask(jwt, taskId, 'parent');
    const afterParent = await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    const parentId = afterParent.body.task.subtasks[0]._id as string;

    const afterChild = await addSubtask(jwt, taskId, 'child', [parentId]);
    const childId = afterChild.subtasks[0].subtasks[0]._id as string;

    const res = await request(app)
      .post(`/api/tasks/${taskId}/subtasks/move`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ fromPath: [parentId], toParentPath: [parentId, childId] })
      .expect(400);

    assert.match(res.body.error, /Cannot move/);
  });

  it('validates fromPath and toParentPath', async () => {
    const { jwt } = await newUser();
    const taskId = await createTask(jwt, 'Root');

    await request(app)
      .post(`/api/tasks/${taskId}/subtasks/move`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ toParentPath: [] })
      .expect(400);

    await request(app)
      .post(`/api/tasks/${taskId}/subtasks/move`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ fromPath: ['abc'] })
      .expect(400);
  });

  it('returns 404 for an unknown subtask id', async () => {
    const { jwt } = await newUser();
    const taskId = await createTask(jwt, 'Root');

    await request(app)
      .post(`/api/tasks/${taskId}/subtasks/move`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ fromPath: [String(new mongoose.Types.ObjectId())], toParentPath: [] })
      .expect(404);
  });

  it('returns 404 for a task the caller cannot reach', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const theirs = await createTask(stranger.jwt, 'Theirs');

    await request(app)
      .post(`/api/tasks/${theirs}/subtasks/move`)
      .set('Authorization', `Bearer ${owner.jwt}`)
      .send({ fromPath: [String(new mongoose.Types.ObjectId())], toParentPath: [] })
      .expect(404);
  });
});
