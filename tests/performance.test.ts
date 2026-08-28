/**
 * Performance regression tests.
 *
 * These do not attempt to measure throughput — that needs a real load
 * generator against a real deployment. What they pin down is the two things
 * that actually regress silently in this codebase:
 *
 *   1. Query shape. An endpoint must not issue work proportional to the
 *      number of rows it touches (the N+1 shape). Query counts are exact and
 *      deterministic, so these are hard assertions.
 *   2. Result bounding. A list endpoint must never let one request pull an
 *      unbounded amount of data, however much the account has accumulated.
 *
 * Wall-clock ceilings are included as a canary for catastrophic regressions
 * only, and are deliberately loose. See tests/helpers/perf.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { registerUser } from './helpers/mcp.js';
import { budget, countQueries, median, percentile, samples, withQueryLog } from './helpers/perf.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-perf-jwt-secret';
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
  mongoose.set('debug', false);
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

async function newUser(prefix: string) {
  return registerUser(`perf-${prefix}-${randomUUID()}@example.com`);
}

/** Seed tasks straight through the model — going via HTTP would dominate runtime. */
async function seedTasks(userId: string, count: number, projectId?: string) {
  const { TaskModel } = await import('../src/models/index.js');
  const docs = Array.from({ length: count }, (_, i) => ({
    userId,
    title: `Perf task ${i}`,
    description: `Description for perf task ${i}`,
    status: ['todo', 'in_progress', 'done'][i % 3],
    priority: ['low', 'medium', 'high', 'urgent'][i % 4],
    ...(projectId ? { projectId, projectIds: [projectId] } : {}),
  }));
  await TaskModel.insertMany(docs);
}

describe('GET /api/tasks stays bounded as an account grows', () => {
  it('never returns more than the page limit, however many tasks exist', async () => {
    const { userId, jwt } = await newUser('bounded');
    await seedTasks(userId, 750);

    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.equal(res.body.total, 750, 'total must still report the true count');
    assert.ok(
      res.body.tasks.length <= res.body.limit,
      `returned ${res.body.tasks.length} tasks for a limit of ${res.body.limit}`
    );
    assert.ok(
      res.body.tasks.length < 750,
      'an unpaginated response would hand the client every task in one payload'
    );
  });

  it('clamps an absurd client-supplied limit', async () => {
    const { userId, jwt } = await newUser('clamp');
    await seedTasks(userId, 750);

    const res = await request(app)
      .get('/api/tasks?limit=100000')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.ok(res.body.limit <= 500, `limit was not clamped: ${res.body.limit}`);
    assert.ok(res.body.tasks.length <= 500);
  });

  it('pages through the full set without gaps or repeats', async () => {
    const { userId, jwt } = await newUser('paging');
    await seedTasks(userId, 120);

    const seen = new Set<string>();
    for (let offset = 0; offset < 120; offset += 50) {
      const res = await request(app)
        .get(`/api/tasks?limit=50&offset=${offset}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      for (const task of res.body.tasks) seen.add(task._id);
    }
    assert.equal(seen.size, 120, 'paging must cover every task exactly once');
  });
});

describe('GET /api/tasks query shape does not scale with the dataset', () => {
  it('issues the same number of queries for 25 tasks as for 1000', async () => {
    const small = await newUser('shape-small');
    await seedTasks(small.userId, 25);

    const large = await newUser('shape-large');
    await seedTasks(large.userId, 1000);

    const fetchFor = (jwt: string) => () =>
      request(app).get('/api/tasks').set('Authorization', `Bearer ${jwt}`).expect(200);

    // Warm up so lazy service imports are not counted against the first call.
    await fetchFor(small.jwt)();
    await fetchFor(large.jwt)();

    const smallQueries = await countQueries(fetchFor(small.jwt));
    const largeQueries = await countQueries(fetchFor(large.jwt));

    assert.equal(
      largeQueries,
      smallQueries,
      `query count grew with the dataset (${smallQueries} -> ${largeQueries}); ` +
        'that is the N+1 shape this endpoint must not have'
    );
  });

  it('issues the same number of queries whatever the page size', async () => {
    const { userId, jwt } = await newUser('shape-page');
    await seedTasks(userId, 500);

    const fetchPage = (limit: number) => () =>
      request(app)
        .get(`/api/tasks?limit=${limit}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);

    await fetchPage(10)();

    const tenQueries = await countQueries(fetchPage(10));
    const twoHundredQueries = await countQueries(fetchPage(200));

    assert.equal(
      twoHundredQueries,
      tenQueries,
      `a 20x larger page issued ${twoHundredQueries} queries vs ${tenQueries} — per-row work`
    );
  });

  it('does not re-query per task when tasks span many projects', async () => {
    const { userId, jwt } = await newUser('shape-projects');
    const { ProjectModel, TaskModel } = await import('../src/models/index.js');

    const projects = await ProjectModel.insertMany(
      Array.from({ length: 20 }, (_, i) => ({ userId, name: `Perf project ${i}` }))
    );
    await TaskModel.insertMany(
      projects.flatMap((project) =>
        Array.from({ length: 5 }, (_, i) => ({
          userId,
          title: `Task ${i} in ${project.name}`,
          projectId: String(project._id),
          projectIds: [String(project._id)],
        }))
      )
    );

    const fetch = () =>
      request(app).get('/api/tasks?limit=100').set('Authorization', `Bearer ${jwt}`).expect(200);
    await fetch();

    const { queries } = await withQueryLog(fetch);
    const projectQueries = queries.filter((q) => q.collection.startsWith('project')).length;

    assert.ok(
      projectQueries <= 2,
      `expected project lookups to be batched, saw ${projectQueries} for 20 projects: ` +
        JSON.stringify(queries.map((q) => `${q.collection}.${q.method}`))
    );
  });
});

describe('GET /api/tasks latency', () => {
  it('serves a page from a large account well inside the budget', async () => {
    const { userId, jwt } = await newUser('latency');
    await seedTasks(userId, 1000);

    const durations = await samples(10, () =>
      request(app).get('/api/tasks?limit=50').set('Authorization', `Bearer ${jwt}`).expect(200)
    );

    const p95 = percentile(durations, 95);
    assert.ok(
      p95 < budget(1500),
      `p95 was ${p95.toFixed(1)}ms over 1000 tasks (budget ${budget(1500)}ms); ` +
        `median ${median(durations).toFixed(1)}ms`
    );
  });

  it('does not get dramatically slower as the account grows', async () => {
    const small = await newUser('scale-small');
    await seedTasks(small.userId, 50);
    const large = await newUser('scale-large');
    await seedTasks(large.userId, 1000);

    const page = (jwt: string) => () =>
      request(app).get('/api/tasks?limit=25').set('Authorization', `Bearer ${jwt}`).expect(200);

    const smallMedian = median(await samples(10, page(small.jwt)));
    const largeMedian = median(await samples(10, page(large.jwt)));

    // A 20x dataset increase reading the same page size should be close to
    // flat. The ceiling is loose because these are milliseconds on a shared
    // runner; it is here to catch a return to unbounded reads, where the cost
    // tracks the account size instead of the page size.
    const ratio = largeMedian / Math.max(smallMedian, 0.5);
    assert.ok(
      ratio < 8,
      `20x more data made the same page ${ratio.toFixed(1)}x slower ` +
        `(${smallMedian.toFixed(1)}ms -> ${largeMedian.toFixed(1)}ms)`
    );
  });
});

describe('paginated endpoints page completely under sort-key ties', () => {
  /**
   * skip/limit over a non-unique sort key is unstable: MongoDB gives no
   * guaranteed order for tied documents, so between two page queries rows can
   * shift across the offset boundary — appearing twice, or never appearing.
   * Bulk-inserted rows share a createdAt millisecond, which is exactly the
   * tie these endpoints hit in production, so each sort needs a unique
   * tiebreaker. Paging must return every row exactly once.
   */
  it('GET /api/tasks pages a bulk-created account exactly once', async () => {
    const { userId, jwt } = await newUser('tie-tasks');
    await seedTasks(userId, 120);

    const seen = new Set<string>();
    let duplicates = 0;
    for (let offset = 0; offset < 120; offset += 20) {
      const res = await request(app)
        .get(`/api/tasks?limit=20&offset=${offset}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      for (const task of res.body.tasks) {
        if (seen.has(task._id)) duplicates += 1;
        seen.add(task._id);
      }
    }

    assert.equal(duplicates, 0, `${duplicates} tasks were returned on more than one page`);
    assert.equal(seen.size, 120, `paging returned ${seen.size} of 120 tasks`);
  });

  it('GET /api/feedback/mine pages bulk-created feedback exactly once', async () => {
    const { userId, jwt } = await newUser('tie-feedback');
    const { FeedbackModel } = await import('../src/models/index.js');
    await FeedbackModel.insertMany(
      Array.from({ length: 60 }, (_, i) => ({
        userId,
        message: `Feedback ${i}`,
        category: 'bug',
        status: 'open',
        attachments: [],
      }))
    );

    const seen = new Set<string>();
    for (let page = 1; page <= 3; page += 1) {
      const res = await request(app)
        .get(`/api/feedback/mine?page=${page}&limit=20`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      for (const item of res.body.items) seen.add(item.id);
    }
    assert.equal(seen.size, 60, `paging returned ${seen.size} of 60 feedback items`);
  });
});

describe('other list endpoints stay bounded', () => {
  it('GET /api/notifications caps the payload and keeps a flat query count', async () => {
    const { userId, jwt } = await newUser('notif');
    const { NotificationModel } = await import('../src/models/index.js');
    await NotificationModel.insertMany(
      Array.from({ length: 300 }, (_, i) => ({
        userId,
        type: 'task_comment',
        payload: { taskTitle: `Task ${i}` },
        read: false,
      }))
    );

    const fetch = () =>
      request(app).get('/api/notifications').set('Authorization', `Bearer ${jwt}`).expect(200);
    const first = await fetch();
    assert.ok(
      first.body.notifications.length <= 50,
      `notifications must stay capped, got ${first.body.notifications.length}`
    );

    const queries = await countQueries(fetch);
    assert.ok(queries <= 3, `expected a small constant query count, got ${queries}`);
  });

  it('GET /api/projects batches user lookups instead of one per project', async () => {
    const { userId, jwt } = await newUser('projects');
    const { ProjectModel } = await import('../src/models/index.js');
    await ProjectModel.insertMany(
      Array.from({ length: 30 }, (_, i) => ({ userId, name: `Project ${i}` }))
    );

    const fetch = () =>
      request(app).get('/api/projects').set('Authorization', `Bearer ${jwt}`).expect(200);
    await fetch();

    const { queries } = await withQueryLog(fetch);
    const userLookups = queries.filter((q) => q.collection.startsWith('user')).length;

    assert.ok(
      userLookups <= 2,
      `expected batched user lookups for 30 projects, saw ${userLookups}`
    );
  });

  it('GET /api/tasks/:id cost does not track the subtask count', async () => {
    const { userId, jwt } = await newUser('subtasks');
    const { TaskModel } = await import('../src/models/index.js');

    const flat = await TaskModel.create({ userId, title: 'Few subtasks', subtasks: [] });
    const heavy = await TaskModel.create({
      userId,
      title: 'Many subtasks',
      subtasks: Array.from({ length: 200 }, (_, i) => ({ title: `Subtask ${i}`, steps: [] })),
    });

    const get = (id: string) => () =>
      request(app).get(`/api/tasks/${id}`).set('Authorization', `Bearer ${jwt}`).expect(200);

    await get(String(flat._id))();

    const flatQueries = await countQueries(get(String(flat._id)));
    const heavyQueries = await countQueries(get(String(heavy._id)));

    assert.equal(
      heavyQueries,
      flatQueries,
      `200 subtasks changed the query count (${flatQueries} -> ${heavyQueries})`
    );
  });
});
