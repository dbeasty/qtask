import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { link, makePeer, settle } from './helpers/syncHarness.ts';
import { adoptLocalAccount } from '../src/sync/adopt.ts';
import { isDerivedField, isSyncedField, isReplicated, LOCAL_ONLY_COLLECTIONS } from '../src/sync/policy.ts';
import { recKey } from '../src/sync/meta.ts';

describe('replication policy', () => {
  it('keeps sessions, tokens, embeddings, metrics and audits local', () => {
    for (const name of LOCAL_ONLY_COLLECTIONS) assert.equal(isReplicated(name), false, name);
    assert.equal(isReplicated('tasks'), true);
    assert.equal(isSyncedField('tasks', 'embedding'), false);
    assert.equal(isSyncedField('projects', 'embedding'), false);
    assert.equal(isDerivedField('projects', 'trackingRollup'), true);
    assert.equal(isDerivedField('tasks', 'percentComplete'), true);
    // an input weight, not a rollup: must replicate
    assert.equal(isSyncedField('tasks', 'progressShare'), true);
    assert.equal(isSyncedField('projects', 'progressShare'), true);
  });

  it('never ships embeddings or local-only collections across the wire', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    await a.store.collection('tasks').create({ userId: 'u', title: 't', embedding: [0.1, 0.2, 0.3] });
    await a.store.collection('mcpSessions').create({ userId: 'u', keyId: 'k' });
    await a.store.collection('users').create({ email: 'x@example.com', passwordHash: 'secret' });
    await a.store.collection('mcpOAuthRefreshTokens').create({ tokenHash: 'h', userId: 'u' });
    await settle([a, b]);
    const task = (await b.inner.collection('tasks').find({}))[0]!;
    assert.equal(task.embedding, undefined);
    assert.equal(b.inner.count('mcpSessions'), 0);
    assert.equal(b.inner.count('users'), 0);
    assert.equal(b.inner.count('mcpOAuthRefreshTokens'), 0);
  });

  it('does not replicate staged (uncommitted) proposals until they are committed', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    const staged = await a.store.collection('tasks').create({
      userId: 'u',
      title: 'draft',
      staging: { conversationId: 'c1', proposalId: 'p1' },
    });
    await settle([a, b]);
    assert.equal(b.inner.count('tasks'), 0);
    await a.store.collection('tasks').updateOne({ _id: staged._id }, { $unset: { staging: 1 } });
    await settle([a, b]);
    assert.equal(b.inner.count('tasks'), 1);
    // and a rolled-back draft leaves nothing behind
    const draft = await a.store.collection('tasks').create({ userId: 'u', title: 'x', staging: { conversationId: 'c2', proposalId: 'p2' } });
    await a.store.collection('tasks').deleteOne({ _id: draft._id });
    await a.engine.capture();
    assert.equal(a.meta.get(recKey('tasks', String(draft._id))), undefined);
  });
});

describe('derived fields are recomputed, not merged', () => {
  it('a task\'s percentComplete comes from its subtasks on the receiving side', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b', { derived: true });
    const task = await a.store.collection('tasks').create({
      userId: 'u',
      title: 'parent',
      status: 'in_progress',
      percentComplete: 99, // a stale/incorrect cached figure
      subtasks: [
        { _id: 's1', title: 's1', status: 'done', percentComplete: 100, subtasks: [] },
        { _id: 's2', title: 's2', status: 'todo', percentComplete: 0, subtasks: [] },
      ],
    });
    await settle([a, b]);
    const onB = await b.inner.collection('tasks').findById(String(task._id));
    assert.equal(onB?.percentComplete, 50);
    assert.equal(a.meta.get(recKey('tasks', String(task._id)))?.fields.percentComplete, undefined, 'never stamped');
  });

  it('project progress and cost rollups are rebuilt from the merged tasks', async () => {
    const a = await makePeer('a', { derived: true });
    const b = await makePeer('b', { derived: true });
    const project = await a.store.collection('projects').create({ userId: 'u', name: 'P', collaborators: [], hourlyRate: 10 });
    const projectId = String(project._id);
    const t1 = await a.store.collection('tasks').create({ userId: 'u', projectId, title: 't1', status: 'done', percentComplete: 100, hoursSpent: 2, subtasks: [] });
    await settle([a, b]);

    // b adds more work while a marks the first task done differently; both are offline
    await b.store.collection('tasks').create({ userId: 'u', projectId, title: 't2', status: 'todo', percentComplete: 0, hoursSpent: 3, subtasks: [] });
    await a.store.collection('tasks').updateOne({ _id: t1._id }, { $set: { hoursSpent: 4 } });
    await settle([a, b]);

    for (const peer of [a, b]) {
      const doc = await peer.inner.collection('projects').findById(projectId);
      assert.equal(doc?.percentComplete, 50, `${peer.name} percent`);
      assert.equal(doc?.status, 'in_progress', `${peer.name} status`);
      assert.equal((doc?.trackingRollup as { hoursSpent: number }).hoursSpent, 7, `${peer.name} hours`);
    }
  });

  it('a stale rollup from a peer cannot overwrite the receiving side figure', async () => {
    const a = await makePeer('a', { derived: true });
    const b = await makePeer('b', { derived: true });
    const project = await a.store.collection('projects').create({ userId: 'u', name: 'P', collaborators: [] });
    const projectId = String(project._id);
    await settle([a, b]);
    // b fakes a wildly wrong cached rollup directly in storage (as an old client might)
    await b.inner.collection('projects').updateOne({ _id: projectId }, { $set: { percentComplete: 77 } });
    await b.store.collection('projects').updateOne({ _id: projectId }, { $set: { notes: 'touch' } });
    await settle([a, b]);
    assert.equal((await a.inner.collection('projects').findById(projectId))?.percentComplete, 0);
  });
});

describe('adopt-account', () => {
  it('re-owns local-user documents to the account and syncs them under it', async () => {
    const device = await makePeer('device');
    const hub = await makePeer('hub', { role: 'hub' });
    const project = await device.store.collection('projects').create({ userId: 'local', name: 'Home', collaborators: [{ userId: 'local', role: 'editor' }] });
    const task = await device.store.collection('tasks').create({ userId: 'local', projectId: String(project._id), title: 'offline task', assigneeId: 'local' });
    await device.store.collection('comments').create({ userId: 'local', taskId: String(task._id), body: 'hi' });
    await device.store.collection('tasks').create({ userId: 'local', title: 'inbox' });

    const result = await adoptLocalAccount(device.engine, 'local', 'acct-1');
    assert.equal(result.total, 4);
    assert.deepEqual(Object.keys(result.reowned).sort(), ['comments', 'projects', 'tasks']);

    for (const coll of ['tasks', 'projects', 'comments'] as const) {
      for (const doc of await device.inner.collection(coll).find({})) {
        assert.equal(doc.userId, 'acct-1', `${coll} ${String(doc._id)}`);
      }
    }
    assert.equal((await device.inner.collection('tasks').findById(String(task._id)))?.assigneeId, 'acct-1');
    assert.deepEqual((await device.inner.collection('projects').findById(String(project._id)))?.collaborators, [
      { userId: 'acct-1', role: 'editor' },
    ]);

    // replicate into the hub through the authorizer for the account
    const { HubAuthorizer } = await import('../src/sync/hub.ts');
    const { LoopbackTransport } = await import('../src/sync/transport.ts');
    const sync = await device.engine.syncWith(new LoopbackTransport(hub.engine.service(new HubAuthorizer(hub.store, 'acct-1'))));
    assert.equal(sync.rejected.length, 0, JSON.stringify(sync.rejected));
    assert.equal(hub.inner.count('tasks'), 2);
    assert.equal(hub.inner.count('projects'), 1);
    assert.equal(hub.inner.count('comments'), 1);
    for (const doc of await hub.inner.collection('tasks').find({})) assert.equal(doc.userId, 'acct-1');

    // a second device of the same account sees everything
    const other = await makePeer('phone');
    await other.engine.syncWith(new LoopbackTransport(hub.engine.service(new HubAuthorizer(hub.store, 'acct-1'))));
    assert.equal(other.inner.count('tasks'), 2);
  });

  it('is idempotent and a no-op for the same user', async () => {
    const device = await makePeer('device');
    await device.store.collection('tasks').create({ userId: 'local', title: 't' });
    assert.equal((await adoptLocalAccount(device.engine, 'local', 'acct')).total, 1);
    assert.equal((await adoptLocalAccount(device.engine, 'local', 'acct')).total, 0);
    assert.equal((await adoptLocalAccount(device.engine, 'acct', 'acct')).total, 0);
  });

  it('pending offline edits are not lost when adoption happens before the first sync', async () => {
    const device = await makePeer('device');
    const hub = await makePeer('hub', { role: 'hub' });
    const task = await device.store.collection('tasks').create({ userId: 'local', title: 'v1' });
    await device.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'v2' } });
    await adoptLocalAccount(device.engine, 'local', 'acct');
    const { HubAuthorizer } = await import('../src/sync/hub.ts');
    const { LoopbackTransport } = await import('../src/sync/transport.ts');
    await device.engine.syncWith(new LoopbackTransport(hub.engine.service(new HubAuthorizer(hub.store, 'acct'))));
    const onHub = await hub.inner.collection('tasks').findById(String(task._id));
    assert.equal(onHub?.title, 'v2');
    assert.equal(onHub?.userId, 'acct');
    assert.ok(link);
  });
});
