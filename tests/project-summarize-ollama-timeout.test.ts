import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';

let mongo: MongoMemoryServer;
const originalFetch = globalThis.fetch;
const originalAbortSignalTimeout = AbortSignal.timeout;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalAbortSignalTimeout;
  await mongoose.disconnect();
  await mongo.stop();
});

describe('summarizeProject does not hang forever on a stalled Ollama request', () => {
  it('aborts and falls back to a plain-text summary instead of hanging indefinitely', async () => {
    // Fire almost immediately regardless of the requested duration, so
    // the test doesn't have to wait out the real timeout to prove it
    // exists and works.
    AbortSignal.timeout = ((_ms: number) => originalAbortSignalTimeout(10)) as typeof AbortSignal.timeout;

    // Simulates a stalled Ollama server: the fetch never resolves on its
    // own, and only rejects if the caller's abort signal actually fires —
    // exactly like real fetch() behaves when passed a signal.
    let sawAbortableSignal = false;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      sawAbortableSignal = signal instanceof AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch;

    const { ProjectModel, TaskModel } = await import('../src/models/index.js');
    const { projectService } = await import('../src/services/projectService.js');

    const userId = new mongoose.Types.ObjectId().toString();
    const project = await ProjectModel.create({
      userId,
      name: 'Stalled Summary Project',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
    });
    await TaskModel.create({
      userId,
      title: 'A task',
      status: 'todo',
      projectId: String(project._id),
      projectIds: [String(project._id)],
    });

    const start = Date.now();
    const summary = await Promise.race([
      projectService.summarizeProject(userId, String(project._id)),
      new Promise<string>((_resolve, reject) =>
        setTimeout(() => reject(new Error('summarizeProject did not return in time')), 5000)
      ),
    ]);
    const elapsedMs = Date.now() - start;

    assert.ok(sawAbortableSignal, 'expected the Ollama fetch to be given an AbortSignal');
    assert.ok(elapsedMs < 5000, `expected summarizeProject to abort quickly, took ${elapsedMs}ms`);
    assert.ok(summary.includes('Stalled Summary Project'), 'expected the plain-text fallback summary');
  });
});
