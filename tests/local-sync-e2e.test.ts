/**
 * Two local-mode devices in separate processes (each its own kdb-service and data
 * directory, exactly the backend the Mac app runs), paired through /api/local-sync and
 * syncing over the Wi-Fi transport on this Mac (TLS listener on every interface,
 * discovery by mDNS on a private port over loopback). Everything is checked through the
 * normal REST API, as the app sees it.
 *
 * Skips when kdb-service or @kdb/client is not available (as the KDB suites do).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LocalDevice, freePort, kdbMissing, pairDevices, sleep, waitFor } from './helpers/local-device.ts';

const LOCAL_OWNER_ID = '717461736b6c6f63616c3031';

describe('device sync between two local-mode processes', { skip: kdbMissing, timeout: 300_000 }, () => {
  let a: LocalDevice;
  let b: LocalDevice;

  before(async () => {
    const mdnsPort = await freePort();
    a = new LocalDevice({ name: 'Mac A', mdnsPort });
    b = new LocalDevice({ name: 'Mac B', mdnsPort });
    await Promise.all([a.start(), b.start()]);
  });

  after(async () => {
    await Promise.allSettled([a?.stop(), b?.stop()]);
  });

  const taskOn = (d: LocalDevice, id: string) => d.api('GET', `/api/tasks/${id}`).then((r) => (r.status === 200 ? r.body.task : null));

  it('both devices own their data as the shared local user and have one default project', async () => {
    for (const d of [a, b]) {
      const me = await d.api('GET', '/api/auth/me');
      assert.equal(me.body.user.id, LOCAL_OWNER_ID);
      const s = await d.status();
      assert.equal(s.device.name, d.name);
      assert.equal(s.peers.length, 0);
      assert.equal(s.wifi.running, true);
    }
    const [pa, pb] = await Promise.all([a.projects(), b.projects()]);
    assert.equal(pa.length, 1);
    assert.equal(pa[0]!._id, pb[0]!._id, 'the default project id is the same on both devices');
  });

  it('pairs with the QR link and connects over Wi-Fi', async () => {
    const open = await a.sync('POST', '/pair/open');
    assert.equal(open.status, 200);
    assert.match(open.body.link, /^qtask:\/\/pair\?h=127\.0\.0\.1:\d+&id=[0-9a-f]{32}&fp=[0-9a-f]{64}&s=/);
    assert.match(open.body.qrSvg, /^<svg /);
    assert.match(open.body.codeLink, /^qtask:\/\/pair\?h=127\.0\.0\.1:\d+$/);
    const join = await b.sync('POST', '/pair/join', { link: open.body.link });
    assert.equal(join.status, 200);
    assert.equal(join.body.phase, 'paired');
    await waitFor('a Wi-Fi link on both sides', async () => {
      const [sa, sb] = await Promise.all([a.status(), b.status()]);
      return sa.peers[0]?.connected && sb.peers[0]?.connected && sa.peers[0].transport === 'wifi' && sb.peers[0].transport === 'wifi';
    }, 30_000);
    const sa = await a.status();
    assert.equal(sa.peers[0].name, 'Mac B');
    assert.equal(sa.pairing.phase, 'paired');
  });

  it('replicates creates, edits and deletes of tasks and projects through REST', async () => {
    const project = await a.api('POST', '/api/projects', { name: 'Garden' });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const projectId = project.body.project._id;
    const created = await a.api('POST', '/api/tasks', { title: 'Plant tulips', projectId });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.task._id;

    const onB = await waitFor('the task on B', () => taskOn(b, id));
    assert.equal(onB.title, 'Plant tulips');
    assert.ok((await b.projects()).some((p) => p._id === projectId), 'the project arrived too');

    // Edit on B, see it on A.
    assert.equal((await b.api('PATCH', `/api/tasks/${id}`, { title: 'Plant tulips and crocuses', status: 'in_progress' })).status, 200);
    await waitFor('the edit on A', async () => (await taskOn(a, id))?.title === 'Plant tulips and crocuses');
    assert.equal((await taskOn(a, id)).status, 'in_progress');

    // Project rename on A, see it on B.
    assert.equal((await a.api('PATCH', `/api/projects/${projectId}`, { name: 'Garden 2026' })).status, 200);
    await waitFor('the rename on B', async () => (await b.projects()).find((p) => p._id === projectId)?.name === 'Garden 2026');

    // Delete the task on A: gone on B.
    assert.equal((await a.api("DELETE", `/api/tasks/${id}`)).status, 204);
    await waitFor('the delete on B', async () => (await taskOn(b, id)) === null);

    // Delete the project on B (with a task in it): gone on A, with its task.
    const t2 = (await b.api('POST', '/api/tasks', { title: 'Buy compost', projectId })).body.task._id;
    await waitFor('t2 on A', () => taskOn(a, t2));
    const del = await b.api('DELETE', `/api/projects/${projectId}`);
    assert.ok(del.status === 200 || del.status === 204, JSON.stringify(del.body));
    await waitFor('project delete on A', async () => !(await a.projects()).some((p) => p._id === projectId));
    await waitFor('its task gone on A', async () => (await taskOn(a, t2)) === null);
  });

  it('reports a same-field conflict in status on both devices', async () => {
    let found: any;
    for (let attempt = 0; attempt < 4 && !found; attempt++) {
      const id = (await a.api('POST', '/api/tasks', { title: `Conflict ${attempt}` })).body.task._id;
      await waitFor('task on B', () => taskOn(b, id));
      await sleep(1000); // let the creating round settle on both sides
      // Both devices change the same field before either has synced (the write debounce is 400 ms).
      await Promise.all([
        a.api('PATCH', `/api/tasks/${id}`, { title: `From A ${attempt}` }),
        b.api('PATCH', `/api/tasks/${id}`, { title: `From B ${attempt}` }),
      ]);
      const titles = await waitFor('convergence', async () => {
        const [ta, tb] = await Promise.all([taskOn(a, id), taskOn(b, id)]);
        return ta.title === tb.title && ta.title !== `Conflict ${attempt}` ? ta.title : null;
      });
      found = await waitFor(
        'the conflict in status',
        async () => {
          const s = await a.status();
          return s.conflicts.find((c: any) => c.documentId === id && c.field === 'title');
        },
        8_000
      ).catch(() => undefined);
      if (found) {
        assert.equal(found.kept, titles);
        assert.match(String(found.discarded), /^From [AB] /);
        assert.equal(found.title, titles);
        // The conflict entry replicates: B lists it too.
        await waitFor('the conflict on B', async () => (await b.status()).conflicts.some((c: any) => c.id === found.id));
      }
    }
    assert.ok(found, 'a same-field conflict was recorded');
  });

  it('a device killed with SIGKILL keeps its pairing, its tombstones and cursors, and catches up', async () => {
    // A task B has synced, then deleted on B and B killed before the debounced round runs.
    const doomed = (await b.api('POST', '/api/tasks', { title: 'Delete me then crash' })).body.task._id;
    await waitFor('doomed on A', () => taskOn(a, doomed));
    await sleep(800);
    assert.equal((await b.api("DELETE", `/api/tasks/${doomed}`)).status, 204);
    await b.kill9();
    await sleep(600);
    assert.ok(await taskOn(a, doomed), 'the delete had not reached A before the crash (so it must come from B\'s records)');

    // While B is down, A keeps working.
    const whileDown = (await a.api('POST', '/api/tasks', { title: 'Written while B was down' })).body.task._id;
    const meta = JSON.parse(readFileSync(path.join(b.dataDir, 'sync', 'meta.json'), 'utf8'));
    const cursor = meta.peers[(await a.status()).device.nodeId];
    assert.ok(cursor && cursor.pulledSeq > 0 && cursor.pushedSeq > 0, 'B persisted its cursors for A');

    await b.start();
    const sb = await b.status();
    assert.equal(sb.peers.length, 1, 'B still has its pairing after the crash');
    await waitFor('B caught up with the write made while it was down', () => taskOn(b, whileDown), 30_000);
    await waitFor('the delete B made just before the crash reached A', async () => (await taskOn(a, doomed)) === null, 30_000);
    // And B's own writes after the restart flow again.
    const after = (await b.api('POST', '/api/tasks', { title: 'After restart' })).body.task._id;
    await waitFor('after-restart task on A', () => taskOn(a, after));
  });

  it('sync now, pending count and the long-poll revision', async () => {
    const before = (await a.sync('GET', '/revision')).body.revision;
    const poll = a.sync('GET', `/revision?since=${before}&wait=10000`);
    await b.api('POST', '/api/tasks', { title: 'Wake A up' });
    const r = await poll;
    assert.ok(r.body.revision > before, 'the revision moved when B pushed');
    const now = await a.sync('POST', '/now');
    assert.equal(now.status, 200);
    const s = await a.status();
    assert.equal(s.peers[0].pendingChanges, 0);
    assert.ok(s.peers[0].lastSyncedAt);
  });

  it('unpair stops sync in both directions', async () => {
    const aId = (await a.status()).device.nodeId;
    const del = await b.sync('DELETE', `/peers/${aId}`);
    assert.equal(del.status, 200);
    await waitFor('the link to drop', async () => !(await a.status()).peers[0]?.connected && (await b.status()).peers.length === 0);
    const fromA = (await a.api('POST', '/api/tasks', { title: 'Not for B' })).body.task._id;
    const fromB = (await b.api('POST', '/api/tasks', { title: 'Not for A' })).body.task._id;
    await sleep(3000);
    assert.equal(await taskOn(b, fromA), null);
    assert.equal(await taskOn(a, fromB), null);
    // A still lists B (it was not told), but cannot reach it: B refuses an unpaired certificate.
    assert.equal((await a.status()).peers[0].connected, false);
  });
});
