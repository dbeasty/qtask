import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';

let mongo: MongoMemoryServer;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('subtask schema validation applies at every nesting depth, not just depth 1', () => {
  it('rejects a depth-2 subtask with an invalid status, out-of-range percentComplete, and no title', async () => {
    const { TaskModel } = await import('../src/models/index.js');

    await assert.rejects(
      () =>
        TaskModel.create({
          userId: 'depth-validation-user',
          title: 'Top-level task',
          status: 'todo',
          subtasks: [
            {
              title: 'Depth 1 subtask',
              subtasks: [
                {
                  // No title — should fail required validation.
                  status: 'not-a-real-status',
                  percentComplete: 99999,
                },
              ],
            },
          ],
        }),
      (err: Error) => {
        assert.match(err.message, /title.*required/);
        assert.match(err.message, /status.*not-a-real-status/);
        assert.match(err.message, /percentComplete/);
        return true;
      }
    );
  });

  it('still accepts a valid depth-2 subtask', async () => {
    const { TaskModel } = await import('../src/models/index.js');

    const task = await TaskModel.create({
      userId: 'depth-validation-user-2',
      title: 'Top-level task',
      status: 'todo',
      subtasks: [
        {
          title: 'Depth 1 subtask',
          subtasks: [
            {
              title: 'Depth 2 subtask',
              status: 'in_progress',
              percentComplete: 40,
              subtasks: [{ title: 'Depth 3 subtask', status: 'done', percentComplete: 100 }],
            },
          ],
        },
      ],
    });

    const depth1 = task.subtasks[0] as unknown as { subtasks: Array<Record<string, unknown>> };
    const depth2 = depth1.subtasks[0] as unknown as { title: string; subtasks: Array<Record<string, unknown>> };
    assert.equal(depth2.title, 'Depth 2 subtask');
    assert.equal(depth2.subtasks[0]?.title, 'Depth 3 subtask');
  });
});
