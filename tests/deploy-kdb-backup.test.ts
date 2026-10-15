/**
 * deploy/kdb-backup.sh's retention: which backups and which shared segment objects `prune` removes.
 * Runs the script against a backup directory laid out as kdb-service writes one (manifests under
 * backups/<ns>/<id>/, content-addressed sealed segments under backup-segments/<ns>/); no KDB needed.
 * The backup and verify half is exercised against a real kdb-service by scripts/kdb-restore-drill.ts.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = resolve(import.meta.dirname, '..', 'deploy', 'kdb-backup.sh');
const NS = 'qtask/docs';
const DAY = 86_400;

describe('kdb-backup.sh prune', () => {
  const root = mkdtempSync(join(tmpdir(), 'kdb-backup-prune-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  const ago = (path: string, days: number) => {
    const t = Date.now() / 1000 - days * DAY;
    utimesSync(path, t, t);
  };
  const segment = (name: string, days: number) => {
    const path = join(root, 'backup-segments', NS, name);
    mkdirSync(join(root, 'backup-segments', NS), { recursive: true });
    writeFileSync(path, 'x');
    ago(path, days);
    return `backup-segments/${NS}/${name}`;
  };
  const backup = (id: string, days: number, keys: string[]) => {
    const dir = join(root, 'backups', NS, id);
    mkdirSync(dir, { recursive: true });
    const manifest = join(dir, 'manifest.json');
    // Indented, as Go's encoder may write it: the prune must not depend on compact JSON.
    writeFileSync(manifest, JSON.stringify({ formatVersion: 1, backupId: id, segments: keys.map((key, i) => ({ sequence: i, key })) }, null, 2));
    ago(manifest, days);
    ago(dir, days);
  };

  it('keeps recent backups and the newest few, and sweeps only old unreferenced segments', () => {
    const shared = segment('00000000000000000001-aaa.seg', 30); // named by a kept backup
    const onlyOld = segment('00000000000000000002-bbb.seg', 30); // named only by pruned backups
    const young = segment('00000000000000000003-ccc.seg', 0); // unreferenced, but may belong to a backup in progress
    const orphan = segment('00000000000000000004-ddd.seg', 30); // unreferenced and old
    // UUID-like ids whose lexical order is the opposite of their age.
    backup('ffff-oldest', 40, [shared, onlyOld]);
    backup('eeee-old', 30, [onlyOld]);
    backup('dddd-older-kept', 20, [shared]);
    backup('bbbb-recent', 2, [shared]);
    backup('aaaa-newest', 1, [shared]);

    const result = spawnSync('bash', [SCRIPT, 'prune'], {
      encoding: 'utf8',
      env: { ...process.env, KDB_BACKUP_DIR: root, KDB_NAMESPACE: NS, KDB_RETENTION_DAYS: '14', KDB_RETENTION_MIN: '3' },
    });
    assert.equal(result.status, 0, result.stderr);
    const kept = (id: string) => existsSync(join(root, 'backups', NS, id, 'manifest.json'));
    assert.ok(kept('aaaa-newest') && kept('bbbb-recent'), 'inside the retention window');
    assert.ok(kept('dddd-older-kept'), 'past the window, but one of the newest three');
    assert.ok(!kept('eeee-old') && !kept('ffff-oldest'), 'past the window and not among the newest three');
    assert.ok(existsSync(join(root, shared)), 'still named by a kept manifest');
    assert.ok(!existsSync(join(root, onlyOld)), 'named only by pruned manifests');
    assert.ok(existsSync(join(root, young)), 'too young to sweep');
    assert.ok(!existsSync(join(root, orphan)), 'old and unreferenced');
    assert.match(result.stderr, /pruned 2 backup\(s\), 2 unreferenced segment object\(s\); 3 backup\(s\) kept/);
  });

  it('does nothing when there is nothing to prune', () => {
    const empty = mkdtempSync(join(tmpdir(), 'kdb-backup-empty-'));
    try {
      const result = spawnSync('bash', [SCRIPT, 'prune'], { encoding: 'utf8', env: { ...process.env, KDB_BACKUP_DIR: empty, KDB_NAMESPACE: NS } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /nothing to prune/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
