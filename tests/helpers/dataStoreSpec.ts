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

      it('returns dates as Dates at every depth, not only at the top level', async () => {
        const stamp = new Date('2026-05-06T07:08:09.010Z');
        const projects = store.collection('projects');
        const created = await projects.create({
          userId: 'u1',
          name: 'dated',
          trackingRollup: { hoursSpent: 3, updatedAt: stamp },
        });
        const found = (await projects.findById(created._id as string))!;
        const rollup = found.trackingRollup as { updatedAt: unknown };
        assert.ok(rollup.updatedAt instanceof Date, `updatedAt came back as ${typeof rollup.updatedAt}`);
        assert.equal((rollup.updatedAt as Date).toISOString(), stamp.toISOString());
        assert.ok(found.createdAt instanceof Date);
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

    describe('positional updates', () => {
      // `pendingProposals.$.status` with the element chosen by the filter: how the agent and MCP
      // flows approve or reject one proposal without rewriting the whole array.
      it('updates only the array element the filter matched', async () => {
        const conversations = store.collection('conversations');
        const created = await conversations.create({
          userId: 'u1',
          pendingProposals: [
            { id: 'a', status: 'pending' },
            { id: 'b', status: 'pending' },
            { id: 'c', status: 'pending' },
          ],
        });
        const updated = await conversations.findOneAndUpdate(
          { _id: created._id, userId: 'u1', 'pendingProposals.id': 'b' },
          { $set: { 'pendingProposals.$.status': 'approved' } },
          { returnDocument: 'after' }
        );
        const status = (id: string) =>
          (updated?.pendingProposals as Array<{ id: string; status: string }>).find((p) => p.id === id)?.status;
        assert.equal(status('a'), 'pending');
        assert.equal(status('b'), 'approved');
        assert.equal(status('c'), 'pending');
      });

      it('lands both of two concurrent updates to different elements', async () => {
        const conversations = store.collection('conversations');
        const created = await conversations.create({
          userId: 'u1',
          pendingProposals: [
            { id: 'a', status: 'pending' },
            { id: 'b', status: 'pending' },
          ],
        });
        await Promise.all(
          ['a', 'b'].map((id) =>
            conversations.findOneAndUpdate(
              { _id: created._id, 'pendingProposals.id': id },
              { $set: { 'pendingProposals.$.status': 'approved' } }
            )
          )
        );
        const final = (await conversations.findById(created._id as string))!;
        assert.deepEqual(
          (final.pendingProposals as Array<{ status: string }>).map((p) => p.status),
          ['approved', 'approved']
        );
      });

      it('leaves the document alone when the filter matches no element', async () => {
        const conversations = store.collection('conversations');
        const created = await conversations.create({ userId: 'u1', pendingProposals: [{ id: 'a', status: 'pending' }] });
        const result = await conversations.updateOne(
          { _id: created._id, 'pendingProposals.id': 'zzz' },
          { $set: { 'pendingProposals.$.status': 'approved' } }
        );
        assert.equal(result.matched, 0);
        assert.equal(((await conversations.findById(created._id as string))!.pendingProposals as Array<{ status: string }>)[0].status, 'pending');
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

      it('removes a field replaced with undefined, as Mongo does', async () => {
        // `user.emailVerificationTokenHash = undefined; replaceOne(...)` is how the application
        // retires a one-time token. If the old value survives, the token stays usable.
        const user = await users.create({
          email: 'undef@example.com',
          displayName: 'U',
          passwordHash: 'x',
          emailVerificationTokenHash: 'secret-hash',
          emailVerificationExpires: new Date(Date.now() + 60_000),
        });
        const loaded = (await users.findById(user._id as string))!;
        loaded.emailVerificationTokenHash = undefined;
        loaded.emailVerificationExpires = undefined;
        await users.replaceOne({ _id: loaded._id }, loaded);

        const again = (await users.findById(user._id as string))!;
        assert.equal(again.emailVerificationTokenHash, undefined, 'the token hash must be gone');
        assert.equal(again.emailVerificationExpires, undefined, 'the expiry must be gone');
        assert.equal('emailVerificationTokenHash' in again, false);
        assert.equal(await users.countDocuments({ emailVerificationTokenHash: 'secret-hash' }), 0);
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

    describe('concurrent writes', () => {
      it('lets exactly one of several concurrent conditional updates win', async () => {
        const doc = await tasks.create({ userId: 'u1', title: 'claim me' });
        // "Claim it if nobody has" with the condition in the filter - how the application
        // implements feedback replies, proposal approval and queue claims.
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            tasks.updateOne({ _id: doc._id, status: 'todo' }, { $set: { status: 'in_progress', title: `winner-${i}` } })
          )
        );
        assert.equal(results.filter((r) => r.matched === 1).length, 1, 'exactly one claim may succeed');
        assert.equal(results.filter((r) => r.modified === 1).length, 1);
        const final = (await tasks.findById(doc._id as string))!;
        assert.equal(final.status, 'in_progress');
        assert.match(final.title as string, /^winner-\d$/);
      });

      it('lets exactly one concurrent findOneAndUpdate claim a document', async () => {
        const doc = await tasks.create({ userId: 'u1', title: 'queued' });
        const claims = await Promise.all(
          Array.from({ length: 6 }, () =>
            tasks.findOneAndUpdate({ _id: doc._id, status: 'todo' }, { $set: { status: 'in_progress' } }, { returnDocument: 'after' })
          )
        );
        assert.equal(claims.filter((c) => c !== null).length, 1);
      });

      it('does not lose concurrent increments', async () => {
        const doc = await tasks.create({ userId: 'u1', title: 'counter', percentComplete: 0 });
        await Promise.all(Array.from({ length: 20 }, () => tasks.updateOne({ _id: doc._id }, { $inc: { percentComplete: 1 } })));
        assert.equal((await tasks.findById(doc._id as string))?.percentComplete, 20);
      });

      it('lets exactly one of several concurrent deletes of a document report success', async () => {
        const doc = await tasks.create({ userId: 'u1', title: 'delete once' });
        const results = await Promise.all(Array.from({ length: 6 }, () => tasks.deleteOne({ _id: doc._id })));
        assert.equal(results.filter((r) => r.deleted === 1).length, 1);
      });

      it('rejects one of two concurrent creates of the same unique value, as a duplicate key', async () => {
        const settled = await Promise.allSettled([
          users.create({ email: 'race@example.com', displayName: 'A', passwordHash: 'x' }),
          users.create({ email: 'race@example.com', displayName: 'B', passwordHash: 'x' }),
        ]);
        assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
        const rejected = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        // The application turns code 11000 into a 409; both backends must raise it.
        assert.equal((rejected.reason as { code?: unknown }).code, 11000);
        assert.equal(await users.countDocuments({ email: 'race@example.com' }), 1);
      });

      it('deletes concurrently without a spurious error on any of them', async () => {
        const created = await Promise.all(
          Array.from({ length: 12 }, (_, i) => tasks.create({ userId: 'u1', title: `bulk-${i}` }))
        );
        // Deletes of different documents, in different shapes, all in flight at once - what
        // `Promise.all` over several collections does in the application.
        const results = await Promise.all([
          ...created.slice(0, 4).map((t) => tasks.deleteOne({ _id: t._id })),
          tasks.deleteMany({ title: { $in: created.slice(4, 8).map((t) => t.title) } }),
          ...created.slice(8).map((t) => tasks.findOneAndDelete({ _id: t._id })),
        ]);
        assert.equal(results.length, 9);
        assert.equal(await tasks.countDocuments({ userId: 'u1' }), 0);
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

      it('reports every validation problem at once, not just the first', async () => {
        await assert.rejects(
          tasks.create({ userId: 'u1', status: 'not-a-real-status', percentComplete: 99999 }),
          (error: Error) => {
            assert.match(error.message, /title/, 'the missing title');
            assert.match(error.message, /status/, 'the invalid status');
            assert.match(error.message, /percentComplete/, 'the out-of-range percent');
            return true;
          }
        );
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
