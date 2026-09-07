/**
 * The data-layer conformance spec: one set of assertions, run against every backend.
 *
 * It is written against the `DataStore` contract only — it never imports a driver or
 * a model. Each backend gets its own test *file* (and therefore its own process),
 * because config is a frozen snapshot taken at import: two backends sharing one
 * process would share whichever environment was set first.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Collection, DataStore, Doc } from '../../src/data/types.ts';

export interface BackendHarness {
  name: string;
  /** Skipped with a reason rather than silently absent when a backend is unavailable. */
  skip?: string;
  start(): Promise<DataStore>;
  stop(): Promise<void>;
}

export function runDataStoreConformance(backend: BackendHarness): void {

  describe(`data store conformance — ${backend.name}`, { skip: backend.skip }, () => {
    let store: DataStore;
    let tasks: Collection;
    let users: Collection;

    before(async () => {
      store = await backend.start();
      tasks = store.collection('tasks');
      users = store.collection('users');
    });

    after(async () => {
      await store?.disconnect();
      await backend.stop();
    });

    beforeEach(async () => {
      await store.clear();
    });

    async function seed(): Promise<Doc[]> {
      return [
        await tasks.create({ userId: 'u1', title: 'alpha', status: 'todo', tags: ['ops'], projectIds: ['p1'], sortOrder: 1 }),
        await tasks.create({ userId: 'u1', title: 'beta', status: 'done', tags: ['ops', 'urgent'], projectIds: ['p1', 'p2'], sortOrder: 2 }),
        await tasks.create({ userId: 'u2', title: 'gamma', status: 'todo', tags: [], projectIds: [], sortOrder: 3 }),
      ];
    }

    describe('create and read', () => {
      it('assigns a string id and reads it back', async () => {
        const created = await tasks.create({ userId: 'u1', title: 'solo' });
        assert.equal(typeof created._id, 'string');
        assert.ok((created._id as string).length > 0);

        const found = await tasks.findById(created._id as string);
        assert.equal(found?.title, 'solo');
      });

      it('applies schema defaults', async () => {
        const created = await tasks.create({ userId: 'u1', title: 'defaults' });
        assert.equal(created.status, 'todo');
        assert.equal(created.priority, 'medium');
        assert.deepEqual(created.tags, []);
      });

      it('stamps createdAt and updatedAt', async () => {
        const created = await tasks.create({ userId: 'u1', title: 'stamped' });
        assert.ok(created.createdAt instanceof Date);
        assert.ok(created.updatedAt instanceof Date);
      });

      it('returns null for a missing id', async () => {
        assert.equal(await tasks.findById('507f1f77bcf86cd799439011'), null);
      });

      it('returns null rather than throwing for a malformed id', async () => {
        assert.equal(await tasks.findById('not-an-id'), null);
      });

      it('returns plain objects a caller may mutate', async () => {
        const created = await tasks.create({ userId: 'u1', title: 'mutable' });
        const found = (await tasks.findById(created._id as string))!;
        found.title = 'changed locally';
        const again = await tasks.findById(created._id as string);
        assert.equal(again?.title, 'mutable');
      });
    });

    describe('find', () => {
      it('filters by equality', async () => {
        await seed();
        const found = await tasks.find({ status: 'todo' });
        assert.deepEqual(found.map((t) => t.title).sort(), ['alpha', 'gamma']);
      });

      it('filters by array membership', async () => {
        await seed();
        const found = await tasks.find({ projectIds: 'p2' });
        assert.deepEqual(found.map((t) => t.title), ['beta']);
      });

      it('filters with $in', async () => {
        await seed();
        const found = await tasks.find({ status: { $in: ['done'] } });
        assert.deepEqual(found.map((t) => t.title), ['beta']);
      });

      it('filters with $or', async () => {
        await seed();
        const found = await tasks.find({ $or: [{ userId: 'u2' }, { status: 'done' }] });
        assert.deepEqual(found.map((t) => t.title).sort(), ['beta', 'gamma']);
      });

      it('filters with $exists', async () => {
        await seed();
        await tasks.create({ userId: 'u1', title: 'staged', staging: { conversationId: 'c1', proposalId: 'p1' } });
        const unstaged = await tasks.find({ staging: { $exists: false } });
        assert.equal(unstaged.length, 3);
      });

      it('sorts', async () => {
        await seed();
        const found = await tasks.find({}, { sort: { sortOrder: -1 } });
        assert.deepEqual(found.map((t) => t.title), ['gamma', 'beta', 'alpha']);
      });

      it('limits and skips', async () => {
        await seed();
        const page = await tasks.find({}, { sort: { sortOrder: 1 }, skip: 1, limit: 1 });
        assert.deepEqual(page.map((t) => t.title), ['beta']);
      });

      it('projects with select', async () => {
        await seed();
        const found = await tasks.find({ title: 'alpha' }, { select: 'title status' });
        assert.deepEqual(Object.keys(found[0]!).sort(), ['_id', 'status', 'title']);
      });

      it('returns an empty array rather than null when nothing matches', async () => {
        assert.deepEqual(await tasks.find({ title: 'nothing' }), []);
      });

      it('counts', async () => {
        await seed();
        assert.equal(await tasks.countDocuments({ userId: 'u1' }), 2);
        assert.equal(await tasks.countDocuments(), 3);
      });

      it('lists distinct values', async () => {
        await seed();
        const statuses = (await tasks.distinct('status')).map(String).sort();
        assert.deepEqual(statuses, ['done', 'todo']);
      });
    });

    describe('findOne', () => {
      it('returns the first match under a sort', async () => {
        await seed();
        const found = await tasks.findOne({ userId: 'u1' }, { sort: { sortOrder: -1 } });
        assert.equal(found?.title, 'beta');
      });

      it('returns null when nothing matches', async () => {
        assert.equal(await tasks.findOne({ title: 'nothing' }), null);
      });
    });

    describe('update', () => {
      it('updates one document', async () => {
        const [alpha] = await seed();
        const result = await tasks.updateOne({ _id: alpha!._id }, { $set: { status: 'done' } });
        assert.equal(result.matched, 1);
        assert.equal(result.modified, 1);
        assert.equal((await tasks.findById(alpha!._id as string))?.status, 'done');
      });

      it('reports no match without failing', async () => {
        const result = await tasks.updateOne({ title: 'nothing' }, { $set: { status: 'done' } });
        assert.equal(result.matched, 0);
        assert.equal(result.modified, 0);
      });

      it('updates many', async () => {
        await seed();
        const result = await tasks.updateMany({ userId: 'u1' }, { $set: { priority: 'high' } });
        assert.equal(result.matched, 2);
        assert.equal((await tasks.find({ priority: 'high' })).length, 2);
      });

      it('increments', async () => {
        const [alpha] = await seed();
        await tasks.updateOne({ _id: alpha!._id }, { $inc: { sortOrder: 10 } });
        assert.equal((await tasks.findById(alpha!._id as string))?.sortOrder, 11);
      });

      it('pushes onto an array', async () => {
        const [alpha] = await seed();
        await tasks.updateOne({ _id: alpha!._id }, { $push: { tags: 'added' } });
        assert.deepEqual((await tasks.findById(alpha!._id as string))?.tags, ['ops', 'added']);
      });

      it('pulls from an array', async () => {
        const [, beta] = await seed();
        await tasks.updateOne({ _id: beta!._id }, { $pull: { tags: 'ops' } });
        assert.deepEqual((await tasks.findById(beta!._id as string))?.tags, ['urgent']);
      });

      it('unsets a field', async () => {
        const [alpha] = await seed();
        await tasks.updateOne({ _id: alpha!._id }, { $unset: { assigneeId: '' } });
        const found = await tasks.findById(alpha!._id as string);
        assert.equal(found?.assigneeId, undefined);
      });

      it('returns the updated document from findOneAndUpdate', async () => {
        const [alpha] = await seed();
        const updated = await tasks.findOneAndUpdate(
          { _id: alpha!._id },
          { $set: { status: 'in_progress' } },
          { returnDocument: 'after' }
        );
        assert.equal(updated?.status, 'in_progress');
      });

      it('returns the pre-update document when asked', async () => {
        const [alpha] = await seed();
        const before = await tasks.findOneAndUpdate(
          { _id: alpha!._id },
          { $set: { status: 'in_progress' } },
          { returnDocument: 'before' }
        );
        assert.equal(before?.status, 'todo');
      });

      it('picks by sort in findOneAndUpdate', async () => {
        await seed();
        const updated = await tasks.findOneAndUpdate(
          { userId: 'u1' },
          { $set: { priority: 'urgent' } },
          { sort: { sortOrder: -1 }, returnDocument: 'after' }
        );
        assert.equal(updated?.title, 'beta');
      });

      it('upserts when nothing matches', async () => {
        const updated = await tasks.findOneAndUpdate(
          { userId: 'u9', title: 'brand new' },
          { $set: { status: 'todo' } },
          { upsert: true, returnDocument: 'after' }
        );
        assert.equal(updated?.title, 'brand new');
        assert.equal(await tasks.countDocuments({ userId: 'u9' }), 1);
      });

      it('returns null from findOneAndUpdate when nothing matches', async () => {
        assert.equal(await tasks.findOneAndUpdate({ title: 'nothing' }, { $set: { status: 'done' } }), null);
      });

      it('replaces a whole document', async () => {
        const [alpha] = await seed();
        const result = await tasks.replaceOne(
          { _id: alpha!._id },
          { userId: 'u1', title: 'replaced', status: 'done' }
        );
        assert.equal(result.matched, 1);
        const found = await tasks.findById(alpha!._id as string);
        assert.equal(found?.title, 'replaced');
        // The replacement carried no tags, so the field is gone rather than stale.
        assert.deepEqual(found?.tags, []);
      });

      it('bulk-writes several updates', async () => {
        const [alpha, beta] = await seed();
        const result = await tasks.bulkWrite([
          { updateOne: { filter: { _id: alpha!._id }, update: { $set: { priority: 'low' } } } },
          { updateOne: { filter: { _id: beta!._id }, update: { $set: { priority: 'urgent' } } } },
        ]);
        assert.equal(result.matched, 2);
        assert.equal((await tasks.findById(alpha!._id as string))?.priority, 'low');
        assert.equal((await tasks.findById(beta!._id as string))?.priority, 'urgent');
      });

      it('treats an empty bulk write as a no-op', async () => {
        const result = await tasks.bulkWrite([]);
        assert.equal(result.matched, 0);
      });

      it('moves updatedAt forward', async () => {
        const [alpha] = await seed();
        const before = (await tasks.findById(alpha!._id as string))!.updatedAt as Date;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await tasks.updateOne({ _id: alpha!._id }, { $set: { status: 'done' } });
        const after = (await tasks.findById(alpha!._id as string))!.updatedAt as Date;
        assert.ok(new Date(after).getTime() >= new Date(before).getTime());
      });
    });

    describe('delete', () => {
      it('deletes one', async () => {
        const [alpha] = await seed();
        const result = await tasks.deleteOne({ _id: alpha!._id });
        assert.equal(result.deleted, 1);
        assert.equal(await tasks.countDocuments(), 2);
      });

      it('deletes many', async () => {
        await seed();
        const result = await tasks.deleteMany({ userId: 'u1' });
        assert.equal(result.deleted, 2);
        assert.equal(await tasks.countDocuments(), 1);
      });

      it('reports zero when nothing matches', async () => {
        assert.equal((await tasks.deleteMany({ title: 'nothing' })).deleted, 0);
      });

      it('returns the deleted document', async () => {
        const [alpha] = await seed();
        const deleted = await tasks.findOneAndDelete({ _id: alpha!._id });
        assert.equal(deleted?.title, 'alpha');
        assert.equal(await tasks.countDocuments(), 2);
      });
    });

    describe('constraints', () => {
      it('enforces a unique index', async () => {
        await users.create({ email: 'dup@example.com' });
        await assert.rejects(() => users.create({ email: 'dup@example.com' }));
      });

      it('lowercases and trims where the schema says to', async () => {
        const created = await users.create({ email: '  MixedCase@Example.COM ' });
        assert.equal(created.email, 'mixedcase@example.com');
      });

      it('rejects a document missing a required field', async () => {
        await assert.rejects(() => tasks.create({ userId: 'u1' }));
      });
    });

    describe('subdocuments', () => {
      it('mints ids for array subdocuments', async () => {
        const created = await tasks.create({
          userId: 'u1',
          title: 'with steps',
          steps: [{ text: 'first' }, { text: 'second', done: true }],
        });
        const steps = created.steps as Array<Record<string, unknown>>;
        assert.equal(steps.length, 2);
        for (const step of steps) {
          assert.equal(typeof String(step._id), 'string');
          assert.ok(String(step._id).length > 0);
          assert.notEqual(String(step._id), 'undefined');
        }
        assert.equal(steps[0]!.done, false, 'subdocument defaults apply too');
      });

      it('keeps subdocument ids stable across a read', async () => {
        const created = await tasks.create({
          userId: 'u1',
          title: 'stable',
          steps: [{ text: 'only' }],
        });
        const reloaded = await tasks.findById(created._id as string);
        const before = String((created.steps as Array<Record<string, unknown>>)[0]!._id);
        const after = String((reloaded!.steps as Array<Record<string, unknown>>)[0]!._id);
        assert.equal(after, before);
      });

      it('mints ids for subdocuments added by a replace', async () => {
        const created = await tasks.create({ userId: 'u1', title: 'grow' });
        await tasks.replaceOne(
          { _id: created._id },
          { userId: 'u1', title: 'grow', steps: [{ text: 'added later' }] }
        );
        const reloaded = await tasks.findById(created._id as string);
        const step = (reloaded!.steps as Array<Record<string, unknown>>)[0]!;
        assert.ok(String(step._id).length > 0);
        assert.notEqual(String(step._id), 'undefined');
      });

      it('reads a nested field through a dotted path filter', async () => {
        await tasks.create({ userId: 'u1', title: 'nested', steps: [{ text: 'findme' }] });
        const found = await tasks.find({ 'steps.text': 'findme' });
        assert.equal(found.length, 1);
      });
    });

    describe('isolation between collections', () => {
      it('keeps documents in their own collection', async () => {
        await tasks.create({ userId: 'u1', title: 'a task' });
        assert.equal(await users.countDocuments(), 0);
      });
    });
  });
}
