import { before, after, beforeEach, describe, it } from 'node:test';
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

beforeEach(async () => {
  const { NotificationModel } = await import('../src/models/index.js');
  await NotificationModel.deleteMany({});
});

after(async () => {
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

async function seed(userId: string, count: number, read = false) {
  const { notificationService } = await import('../src/services/notificationService.js');
  const created = [];
  for (let i = 0; i < count; i += 1) {
    created.push(
      await notificationService.createNotification(userId, 'task_comment', {
        taskTitle: `Task ${i}`,
        commentPreview: `comment ${i}`,
      })
    );
  }
  if (read) {
    const { NotificationModel } = await import('../src/models/index.js');
    await NotificationModel.updateMany({ userId }, { $set: { read: true } });
  }
  return created;
}

describe('GET /api/notifications', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app).get('/api/notifications').expect(401);
  });

  it('returns the caller notifications newest-first', async () => {
    const { userId, jwt } = await registerUser(`notif-${randomUUID()}@example.com`);
    await seed(userId, 3);

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.equal(res.body.notifications.length, 3);
    const times = res.body.notifications.map((n: { createdAt: string }) =>
      new Date(n.createdAt).getTime()
    );
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'must be sorted newest-first');
  });

  it('never leaks another user notifications', async () => {
    const owner = await registerUser(`notif-owner-${randomUUID()}@example.com`);
    const other = await registerUser(`notif-other-${randomUUID()}@example.com`);
    await seed(owner.userId, 4);

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${other.jwt}`)
      .expect(200);

    assert.deepEqual(res.body.notifications, []);
  });

  it('caps the returned list at the service limit of 50', async () => {
    const { userId, jwt } = await registerUser(`notif-cap-${randomUUID()}@example.com`);
    await seed(userId, 55);

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.equal(res.body.notifications.length, 50);
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app).get('/api/notifications/unread-count').expect(401);
  });

  it('counts only the caller unread notifications', async () => {
    const owner = await registerUser(`count-owner-${randomUUID()}@example.com`);
    const other = await registerUser(`count-other-${randomUUID()}@example.com`);
    await seed(owner.userId, 3);
    await seed(other.userId, 7);

    const res = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${owner.jwt}`)
      .expect(200);

    assert.equal(res.body.count, 3);
  });

  it('returns 0 once everything is read', async () => {
    const { userId, jwt } = await registerUser(`count-read-${randomUUID()}@example.com`);
    await seed(userId, 3, true);

    const res = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.equal(res.body.count, 0);
  });
});

describe('PATCH /api/notifications/:id/read', () => {
  it('marks a single notification read and drops the unread count', async () => {
    const { userId, jwt } = await registerUser(`read-${randomUUID()}@example.com`);
    const [first] = await seed(userId, 2);

    const res = await request(app)
      .patch(`/api/notifications/${first!._id}/read`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.equal(res.body.notification.read, true);
    assert.equal(res.body.notification._id, first!._id);

    const count = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.equal(count.body.count, 1);
  });

  it('returns 404 for a notification belonging to another user', async () => {
    const owner = await registerUser(`read-owner-${randomUUID()}@example.com`);
    const attacker = await registerUser(`read-attacker-${randomUUID()}@example.com`);
    const [victim] = await seed(owner.userId, 1);

    await request(app)
      .patch(`/api/notifications/${victim!._id}/read`)
      .set('Authorization', `Bearer ${attacker.jwt}`)
      .expect(404);

    // and it must still be unread for its real owner
    const count = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${owner.jwt}`)
      .expect(200);
    assert.equal(count.body.count, 1);
  });

  it('returns 404 for an unknown id', async () => {
    const { jwt } = await registerUser(`read-404-${randomUUID()}@example.com`);
    await request(app)
      .patch(`/api/notifications/${new mongoose.Types.ObjectId()}/read`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(404);
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks every unread notification read and reports how many changed', async () => {
    const { userId, jwt } = await registerUser(`all-${randomUUID()}@example.com`);
    await seed(userId, 4);

    const res = await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.equal(res.body.count, 4);

    const count = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.equal(count.body.count, 0);
  });

  it('leaves other users notifications untouched', async () => {
    const owner = await registerUser(`all-owner-${randomUUID()}@example.com`);
    const other = await registerUser(`all-other-${randomUUID()}@example.com`);
    await seed(owner.userId, 2);
    await seed(other.userId, 3);

    await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${owner.jwt}`)
      .expect(200);

    const otherCount = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${other.jwt}`)
      .expect(200);
    assert.equal(otherCount.body.count, 3);
  });

  it('reports 0 when there is nothing unread', async () => {
    const { userId, jwt } = await registerUser(`all-none-${randomUUID()}@example.com`);
    await seed(userId, 2, true);

    const res = await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.equal(res.body.count, 0);
  });
});
