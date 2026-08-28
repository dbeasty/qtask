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

describe('deleteProject cleans up comments and batches its writes', () => {
  it("deletes a fully-removed task's comments instead of orphaning them", async () => {
    const { CommentModel, ProjectModel, TaskModel } = await import('../src/models/index.js');
    const { projectService } = await import('../src/services/projectService.js');

    const userId = 'delete-project-owner';
    const project = await ProjectModel.create({
      userId,
      name: 'Solo Project',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
    });

    const task = await TaskModel.create({
      userId,
      title: 'Only task here',
      status: 'todo',
      projectId: String(project._id),
      projectIds: [String(project._id)],
    });

    await CommentModel.create({
      taskId: String(task._id),
      userId,
      body: 'A comment that must not survive the task it belongs to',
    });

    await projectService.deleteProject(userId, String(project._id));

    const remainingTask = await TaskModel.findById(task._id).lean();
    assert.equal(remainingTask, null, 'the task with no other project should be deleted');

    const remainingComments = await CommentModel.find({ taskId: String(task._id) }).lean();
    assert.equal(remainingComments.length, 0, 'comments on the deleted task must not be orphaned');
  });

  it('batches task deletes/updates into bulk operations instead of one round trip per task', async () => {
    const { ProjectModel, TaskModel } = await import('../src/models/index.js');
    const { projectService } = await import('../src/services/projectService.js');

    const userId = 'delete-project-batch-owner';
    const project = await ProjectModel.create({
      userId,
      name: 'Multi-task Project',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
    });
    const otherProject = await ProjectModel.create({
      userId,
      name: 'Other Project',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
    });

    // Three tasks that will be fully deleted (only belong to this project)...
    for (let i = 0; i < 3; i++) {
      await TaskModel.create({
        userId,
        title: `Solo task ${i}`,
        status: 'todo',
        projectId: String(project._id),
        projectIds: [String(project._id)],
      });
    }
    // ...and two that are shared with another project and must be
    // reparented, not deleted.
    for (let i = 0; i < 2; i++) {
      await TaskModel.create({
        userId,
        title: `Shared task ${i}`,
        status: 'todo',
        projectId: String(project._id),
        projectIds: [String(project._id), String(otherProject._id)],
      });
    }

    let deleteOneCalls = 0;
    let updateOneCalls = 0;
    let deleteManyCalls = 0;
    let bulkWriteCalls = 0;
    const originalDeleteOne = TaskModel.deleteOne.bind(TaskModel);
    const originalUpdateOne = TaskModel.updateOne.bind(TaskModel);
    const originalDeleteMany = TaskModel.deleteMany.bind(TaskModel);
    const originalBulkWrite = TaskModel.bulkWrite.bind(TaskModel);
    // These counting wrappers forward an unknown[] rest arg to overloaded
    // Mongoose methods, which TypeScript cannot match to any single overload.
    // Widen the callee to a variadic signature so the forwarding typechecks.
    const forward = <T>(fn: (...a: never[]) => T) => fn as unknown as (...a: unknown[]) => T;

    TaskModel.deleteOne = ((...args: unknown[]) => {
      deleteOneCalls += 1;
      return forward(originalDeleteOne)(...args);
    }) as typeof TaskModel.deleteOne;
    TaskModel.updateOne = ((...args: unknown[]) => {
      updateOneCalls += 1;
      return forward(originalUpdateOne)(...args);
    }) as typeof TaskModel.updateOne;
    TaskModel.deleteMany = ((...args: unknown[]) => {
      deleteManyCalls += 1;
      return forward(originalDeleteMany)(...args);
    }) as typeof TaskModel.deleteMany;
    TaskModel.bulkWrite = ((...args: unknown[]) => {
      bulkWriteCalls += 1;
      return forward(originalBulkWrite)(...args);
    }) as typeof TaskModel.bulkWrite;

    let result;
    try {
      result = await projectService.deleteProject(userId, String(project._id));
    } finally {
      TaskModel.deleteOne = originalDeleteOne;
      TaskModel.updateOne = originalUpdateOne;
      TaskModel.deleteMany = originalDeleteMany;
      TaskModel.bulkWrite = originalBulkWrite;
    }

    assert.equal(result.deletedTaskCount, 3);
    // The pre-fix code called deleteOne/updateOne once per affected task
    // (5 tasks -> 5 calls). The fix batches into deleteMany + bulkWrite.
    assert.equal(deleteOneCalls, 0, 'expected no per-task deleteOne calls');
    assert.equal(updateOneCalls, 0, 'expected no per-task updateOne calls');
    assert.equal(deleteManyCalls, 1, 'expected a single batched deleteMany for removed tasks');
    assert.equal(bulkWriteCalls, 1, 'expected a single batched bulkWrite for reparented tasks');

    const survivors = await TaskModel.find({ projectIds: String(otherProject._id) }).lean();
    assert.equal(survivors.length, 2);
    for (const survivor of survivors) {
      assert.deepEqual(survivor.projectIds, [String(otherProject._id)]);
    }
  });
});
