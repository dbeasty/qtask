/**
 * The device's sync records on disk (FileMetaPersistence, durable mode) and the owner
 * rules. The full crash test (SIGKILL of a syncing backend) is in local-sync-e2e.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FileMetaPersistence } from '../src/sync/meta.ts';
import { LOCAL_OWNER_ID, defaultProjectIdFor, ownerDecision } from '../src/local/owner.ts';

describe('durable sync records', () => {
  it('writes only when something changed, owner-only, and reloads what flush reported', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'qtask-meta-'));
    const path = join(dir, 'sync', 'meta.json');
    const { meta, persistence } = await FileMetaPersistence.open(path, { nodeId: 'n1', durable: true, debounceMs: 60_000 });
    assert.equal(persistence.pending, false);
    await persistence.flushIfChanged();
    assert.equal(persistence.writes, 0, 'nothing to write');
    meta.setPeer('peer', { epoch: 'e', pushedSeq: 7, pulledSeq: 9 });
    assert.equal(persistence.pending, true);
    await persistence.flushIfChanged();
    await persistence.flushIfChanged();
    assert.equal(persistence.writes, 1, 'the second call had nothing new');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const reopened = await FileMetaPersistence.open(path);
    assert.equal(reopened.meta.nodeId, 'n1');
    assert.deepEqual(reopened.meta.peer('peer'), { epoch: 'e', pushedSeq: 7, pulledSeq: 9 });
    await fs.rm(dir, { recursive: true });
  });

  it('a process killed with SIGKILL right after flush() resolved leaves that snapshot', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'qtask-meta-kill-'));
    const path = join(dir, 'meta.json');
    const script = `
      import { FileMetaPersistence } from ${JSON.stringify(join(import.meta.dirname, '../src/sync/meta.ts'))};
      const { meta, persistence } = await FileMetaPersistence.open(${JSON.stringify(path)}, { nodeId: 'k', durable: true });
      meta.setPeer('p', { epoch: 'e', pushedSeq: 42, pulledSeq: 43 });
      await persistence.flush();
      // More changes that are never flushed, then die without any cleanup.
      meta.setPeer('p', { epoch: 'e', pushedSeq: 99, pulledSeq: 99 });
      process.kill(process.pid, 'SIGKILL');
    `;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', r.stderr);
    const { meta } = await FileMetaPersistence.open(path);
    assert.deepEqual(meta.peer('p'), { epoch: 'e', pushedSeq: 42, pulledSeq: 43 });
    await fs.rm(dir, { recursive: true });
  });
});

describe('device owner rules', () => {
  it('local adopts an account, accounts never mix', () => {
    const X = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const Y = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    assert.equal(ownerDecision(LOCAL_OWNER_ID, undefined), 'same');
    assert.equal(ownerDecision(LOCAL_OWNER_ID, LOCAL_OWNER_ID), 'same');
    assert.equal(ownerDecision(LOCAL_OWNER_ID, X), 'adopt');
    assert.equal(ownerDecision(X, LOCAL_OWNER_ID), 'keep');
    assert.equal(ownerDecision(X, X), 'same');
    assert.equal(ownerDecision(X, Y), 'refuse');
  });

  it('derives one default project id per owner, ObjectId-shaped', () => {
    assert.match(defaultProjectIdFor(LOCAL_OWNER_ID), /^[0-9a-f]{24}$/);
    assert.equal(defaultProjectIdFor(LOCAL_OWNER_ID), defaultProjectIdFor(LOCAL_OWNER_ID));
    assert.notEqual(defaultProjectIdFor(LOCAL_OWNER_ID), defaultProjectIdFor('aaaaaaaaaaaaaaaaaaaaaaaa'));
  });
});
