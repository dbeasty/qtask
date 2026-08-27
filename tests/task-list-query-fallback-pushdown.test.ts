import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';

let mongo: MongoMemoryServer;
const originalFetch = globalThis.fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  globalThis.fetch = originalFetch;
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

describe('listTasks pushes its text-search fallback down to Mongo instead of loading every accessible task', () => {
  it('queries once with a $or regex clause rather than fetching everything and filtering in JS', async () => {
    // Text search and semantic search both miss, forcing the regex
    // fallback path.
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) throw new Error('ollama unavailable');
      return originalFetch(input);
    };

    const { TaskModel } = await import('../src/models/index.js');
    const { taskService } = await import('../src/services/taskService.js');

    const userId = 'list-fallback-user';
    await TaskModel.create({ userId, title: 'UniqueZebraTarget', status: 'todo' });
    await TaskModel.create({ userId, title: 'Something else entirely', status: 'todo' });
    await TaskModel.create({ userId, title: 'Yet another unrelated task', status: 'todo' });

    // searchService's own hybrid search already has a bounded-candidate
    // regex fallback of its own (SVC-M4), which would otherwise resolve
    // this query first and make listTasks' own fallback branch
    // unreachable in this test. Stub it out to isolate and exercise
    // listTasks' own fallback path directly and deterministically — the
    // real-world case it protects is a user with more accessible tasks
    // than searchService's candidate cap, where a match can fall outside
    // that bounded window and searchService legitimately comes back empty.
    const { searchService } = await import('../src/services/searchService.js');
    const originalSearchTasksWithFilters = searchService.searchTasksWithFilters.bind(searchService);
    searchService.searchTasksWithFilters = (async () => []) as typeof searchService.searchTasksWithFilters;

    const capturedQueries: Array<Record<string, unknown>> = [];
    const originalFind = TaskModel.find.bind(TaskModel);
    TaskModel.find = ((filter: Record<string, unknown>, ...rest: unknown[]) => {
      capturedQueries.push(filter ?? {});
      return originalFind(filter as never, ...(rest as []));
    }) as typeof TaskModel.find;

    let results;
    try {
      results = await taskService.listTasks(userId, { query: 'ebraTar' });
    } finally {
      TaskModel.find = originalFind;
      searchService.searchTasksWithFilters = originalSearchTasksWithFilters;
    }

    assert.equal(results.length, 1);
    assert.equal((results[0] as { title: string }).title, 'UniqueZebraTarget');

    // The pre-fix code always did one unconditional, unfiltered
    // TaskModel.find(query) fetching every accessible task, then
    // filtered the in-memory results with a JS regex. The fix expresses
    // the regex match as a Mongo $and/$or clause instead.
    const fallbackQuery = capturedQueries.find(
      (q) => Array.isArray(q.$and) && (q.$and as Array<Record<string, unknown>>).some((clause) => clause.$or)
    );
    assert.ok(
      fallbackQuery,
      `expected one TaskModel.find() call with an $and/$or regex clause, got: ${JSON.stringify(capturedQueries)}`
    );
  });

  it('still respects project-access boundaries in the fallback path (not just user-owned tasks)', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) throw new Error('ollama unavailable');
      return originalFetch(input);
    };

    const { ProjectModel, TaskModel } = await import('../src/models/index.js');
    const { taskService } = await import('../src/services/taskService.js');
    const { searchService } = await import('../src/services/searchService.js');

    // Force listTasks into its own fallback branch (see the previous
    // test) so this actually exercises the new $and/$or-wrapped query,
    // rather than passing trivially because searchService's own
    // access-scoped search already handled it.
    const originalSearchTasksWithFilters = searchService.searchTasksWithFilters.bind(searchService);
    searchService.searchTasksWithFilters = (async () => []) as typeof searchService.searchTasksWithFilters;

    const owner = 'boundary-owner';
    const collaborator = 'boundary-collaborator';
    const stranger = 'boundary-stranger';

    const project = await ProjectModel.create({
      userId: owner,
      name: 'Shared Project',
      collaborators: [{ userId: collaborator, role: 'executor' }],
      parentId: null,
      sortOrder: 0,
    });

    await TaskModel.create({
      userId: owner,
      title: 'ZebraMatchInSharedProject',
      status: 'todo',
      projectId: String(project._id),
      projectIds: [String(project._id)],
    });

    // A same-titled task the stranger has no access to at all — the
    // fallback path must not return it just because the regex matches.
    await TaskModel.create({
      userId: 'someone-else-entirely',
      title: 'ZebraMatchInSharedProject',
      status: 'todo',
    });

    try {
      const collaboratorResults = await taskService.listTasks(collaborator, {
        query: 'ZebraMatchInSharedProject',
      });
      assert.equal(collaboratorResults.length, 1, 'collaborator should see the task via project access');

      const strangerResults = await taskService.listTasks(stranger, {
        query: 'ZebraMatchInSharedProject',
      });
      assert.equal(
        strangerResults.length,
        0,
        'stranger must not see tasks outside their access, even with a matching regex'
      );
    } finally {
      searchService.searchTasksWithFilters = originalSearchTasksWithFilters;
    }
  });
});
