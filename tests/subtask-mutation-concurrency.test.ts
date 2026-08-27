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

describe('concurrent subtask structure mutations on the same task', () => {
  it('two concurrent addSubtask calls both succeed instead of one losing to a version conflict', async () => {
    const { TaskModel } = await import('../src/models/index.js');
    const { taskService } = await import('../src/services/taskService.js');

    const userId = 'concurrent-subtask-user';
    const task = await TaskModel.create({
      userId,
      title: 'Parent task',
      status: 'todo',
      subtasks: [],
    });
    const taskId = String(task._id);

    // Fired in the same tick, against the same base document version —
    // without serialization, both read the same subtasks array and race
    // to save, so one of the two saves loses the underlying
    // optimistic-concurrency (VersionError) race and the caller's edit is
    // dropped (or the request errors out) instead of both being applied.
    const results = await Promise.all([
      taskService.addSubtask(userId, taskId, [], { title: 'First subtask' }),
      taskService.addSubtask(userId, taskId, [], { title: 'Second subtask' }),
    ]);

    assert.ok(results[0], 'first addSubtask call should succeed');
    assert.ok(results[1], 'second addSubtask call should succeed');

    const finalTask = await TaskModel.findById(taskId).lean();
    assert.equal(finalTask?.subtasks?.length, 2, 'both concurrent adds must be present, not just one');
    const titles = (finalTask?.subtasks ?? []).map((s) => s.title).sort();
    assert.deepEqual(titles, ['First subtask', 'Second subtask']);
  });

  it('a moveSubtask racing an addSubtask on the same task does not lose either write', async () => {
    const { TaskModel } = await import('../src/models/index.js');
    const { taskService } = await import('../src/services/taskService.js');

    const userId = 'concurrent-subtask-user-2';
    const task = await TaskModel.create({
      userId,
      title: 'Parent task 2',
      status: 'todo',
      subtasks: [{ title: 'Existing subtask', status: 'todo' }],
    });
    const taskId = String(task._id);
    const existingId = String((task.subtasks[0] as { _id: unknown })._id);

    const results = await Promise.all([
      taskService.addSubtask(userId, taskId, [], { title: 'New sibling' }),
      taskService.moveSubtask(userId, taskId, {
        fromPath: [existingId],
        toParentPath: [],
        index: 0,
      }),
    ]);

    assert.ok(results[0], 'addSubtask should succeed');
    assert.ok(results[1], 'moveSubtask should succeed');

    const finalTask = await TaskModel.findById(taskId).lean();
    assert.equal(finalTask?.subtasks?.length, 2, 'both the move and the add must survive');
    const titles = (finalTask?.subtasks ?? []).map((s) => s.title).sort();
    assert.deepEqual(titles, ['Existing subtask', 'New sibling']);
  });
});
