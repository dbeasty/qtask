import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makePeer, type Peer } from './helpers/syncHarness.ts';
import { HubAuthorizer } from '../src/sync/hub.ts';
import { LoopbackTransport } from '../src/sync/transport.ts';
import type { SyncResult } from '../src/sync/types.ts';

let hub: Peer;
let alice: Peer;
let bob: Peer;
let projectId: string;

function as(user: string, device: Peer): () => Promise<SyncResult> {
  return () => device.engine.syncWith(new LoopbackTransport(hub.engine.service(new HubAuthorizer(hub.store, user))));
}

async function sharedProject(role: string) {
  const project = await hub.store.collection('projects').create({
    userId: 'alice',
    name: 'Shared',
    collaborators: [{ userId: 'bob', role }],
  });
  projectId = String(project._id);
  await hub.engine.capture();
}

beforeEach(async () => {
  hub = await makePeer('hub', { role: 'hub' });
  alice = await makePeer('alice-laptop');
  bob = await makePeer('bob-phone');
});

describe('hub authorization', () => {
  it('lets a user push and pull their own documents', async () => {
    await alice.store.collection('tasks').create({ userId: 'alice', title: 'mine' });
    const result = await as('alice', alice)();
    assert.equal(result.rejected.length, 0);
    assert.equal(hub.inner.count('tasks'), 1);

    const second = await makePeer('alice-phone');
    await as('alice', second)();
    assert.equal(second.inner.count('tasks'), 1);
  });

  it('never shows one user another user\'s documents', async () => {
    await hub.store.collection('tasks').create({ userId: 'alice', title: 'alice private' });
    await hub.store.collection('tasks').create({ userId: 'bob', title: 'bob private' });
    await as('bob', bob)();
    const titles = (await bob.inner.collection('tasks').find({})).map((t) => t.title);
    assert.deepEqual(titles, ['bob private']);
  });

  it('rejects a push of documents owned by someone else, including a forged scope', async () => {
    const forged = await bob.store.collection('tasks').create({ userId: 'alice', title: 'planted' });
    const result = await as('bob', bob)();
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]!.reason, /another user/);
    assert.equal(hub.inner.count('tasks'), 0);
    assert.ok(forged);
  });

  it('rejects an attempt to take over an existing document', async () => {
    const task = await hub.store.collection('tasks').create({ userId: 'alice', title: 'alice task' });
    await hub.engine.capture();
    // bob fabricates a wire doc for alice's id with newer stamps
    const evil = await makePeer('evil');
    await evil.store.collection('tasks').create({ _id: String(task._id), userId: 'bob', title: 'bob owns now' });
    const result = await as('bob', evil)();
    assert.equal(result.rejected.length, 1);
    assert.equal((await hub.inner.collection('tasks').findById(String(task._id)))?.title, 'alice task');
  });

  it('gives collaborators the shared project and its tasks, and nothing else', async () => {
    await sharedProject('viewer');
    await hub.store.collection('tasks').create({ userId: 'alice', projectId, title: 'in project' });
    await hub.store.collection('tasks').create({ userId: 'alice', title: 'alice only' });
    await as('bob', bob)();
    assert.equal(bob.inner.count('projects'), 1);
    assert.deepEqual((await bob.inner.collection('tasks').find({})).map((t) => t.title), ['in project']);
  });

  it('viewers cannot push edits, new tasks or deletes', async () => {
    await sharedProject('viewer');
    const task = await hub.store.collection('tasks').create({ userId: 'alice', projectId, title: 'original' });
    await as('bob', bob)();
    await bob.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'hacked' } });
    await bob.store.collection('tasks').create({ userId: 'bob', projectId, title: 'new' });
    const result = await as('bob', bob)();
    assert.equal(result.rejected.length, 2);
    assert.equal((await hub.inner.collection('tasks').findById(String(task._id)))?.title, 'original');
    assert.equal(hub.inner.count('tasks'), 1);

    await bob.store.collection('tasks').deleteOne({ _id: task._id });
    const del = await as('bob', bob)();
    assert.ok(del.rejected.length >= 1);
    assert.ok(await hub.inner.collection('tasks').findById(String(task._id)));
  });

  it('executors may report progress but not edit content or create tasks', async () => {
    await sharedProject('executor');
    const task = await hub.store.collection('tasks').create({ userId: 'alice', projectId, title: 'do it', status: 'todo' });
    await as('bob', bob)();

    await bob.store.collection('tasks').updateOne({ _id: task._id }, { $set: { status: 'in_progress' } });
    const ok = await as('bob', bob)();
    assert.equal(ok.rejected.length, 0);
    assert.equal((await hub.inner.collection('tasks').findById(String(task._id)))?.status, 'in_progress');

    await bob.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'rewritten' } });
    await bob.store.collection('tasks').create({ userId: 'bob', projectId, title: 'new' });
    const bad = await as('bob', bob)();
    assert.equal(bad.rejected.length, 2);
    assert.equal((await hub.inner.collection('tasks').findById(String(task._id)))?.title, 'do it');
  });

  it('editors can edit and create; only owners may change membership', async () => {
    await sharedProject('editor');
    const task = await hub.store.collection('tasks').create({ userId: 'alice', projectId, title: 'shared task' });
    await as('bob', bob)();
    await bob.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'edited by bob' } });
    await bob.store.collection('tasks').create({ userId: 'bob', projectId, title: 'bob adds' });
    const ok = await as('bob', bob)();
    assert.equal(ok.rejected.length, 0);
    assert.equal(hub.inner.count('tasks'), 2);

    await bob.store.collection('projects').updateOne(
      { _id: projectId },
      { $set: { collaborators: [{ userId: 'bob', role: 'manager' }] } }
    );
    const escalate = await as('bob', bob)();
    assert.equal(escalate.rejected.length, 1);
    const project = await hub.inner.collection('projects').findById(projectId);
    assert.deepEqual(project?.collaborators, [{ userId: 'bob', role: 'editor' }]);
  });

  it('a user with no role in the project is rejected and cannot read it', async () => {
    await sharedProject('editor');
    const carol = await makePeer('carol');
    await as('carol', carol)();
    assert.equal(carol.inner.count('projects'), 0);
    await carol.store.collection('tasks').create({ userId: 'carol', projectId, title: 'sneaky' });
    const result = await as('carol', carol)();
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]!.reason, /not a member/);
  });

  it('picks up newly granted access on the next sync', async () => {
    const project = await hub.store.collection('projects').create({ userId: 'alice', name: 'Later', collaborators: [] });
    await hub.store.collection('tasks').create({ userId: 'alice', projectId: String(project._id), title: 't' });
    await as('bob', bob)();
    assert.equal(bob.inner.count('tasks'), 0);

    await hub.store.collection('projects').updateOne(
      { _id: project._id },
      { $set: { collaborators: [{ userId: 'bob', role: 'viewer' }] } }
    );
    await as('bob', bob)();
    assert.equal(bob.inner.count('tasks'), 1, 'scope change restarted the pull from the beginning');
  });
});
