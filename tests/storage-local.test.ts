import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalObjectStorage } from '../src/services/storage/local.js';
import { assertSafeStorageKey } from '../src/services/storage/types.js';

describe('LocalObjectStorage', () => {
  let root: string;
  let storage: LocalObjectStorage;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qtask-storage-'));
    storage = new LocalObjectStorage(root);
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('stores and retrieves objects', async () => {
    const key = 'feedback/11111111-1111-1111-1111-111111111111.png';
    const body = Buffer.from('png-bytes');
    await storage.put(key, body, 'image/png');
    const stored = await storage.get(key);
    assert.ok(stored);
    assert.equal(stored.contentType, 'image/png');
    assert.equal(stored.body.toString(), 'png-bytes');
  });

  it('deletes objects', async () => {
    const key = 'feedback/22222222-2222-2222-2222-222222222222.jpg';
    await storage.put(key, Buffer.from('jpg'), 'image/jpeg');
    await storage.delete(key);
    assert.equal(await storage.get(key), null);
  });

  it('rejects unsafe storage keys', async () => {
    assert.throws(() => assertSafeStorageKey('../secrets.txt'));
    await assert.rejects(
      () => storage.put('../escape.png', Buffer.from('x'), 'image/png'),
      /Invalid storage key/
    );
  });
});
