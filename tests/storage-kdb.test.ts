/**
 * STORAGE_BACKEND=kdb against a real kdb-service: uploads stored as KDB attachments.
 *
 * One on-disk service (`--data-dir`, `--durability sync`) serves the whole file, so the last tests
 * can kill it without warning, start it again on the same directory, and check what survived -
 * and can damage a stored blob on disk to check that the damage surfaces as an integrity error
 * rather than as a missing file.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_MODULE, SERVICE_BIN, kdbUnavailable } from './helpers/kdbRelease.ts';
import type { KdbObjectStorage as KdbObjectStorageType } from '../src/services/storage/kdb.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const PORT = Number(process.env.KDB_TEST_PORT_STORAGE ?? 7921);
const NS = 'qtaskfiles/docs';
const MIB = 1024 * 1024;
const skip = kdbUnavailable;

const key = (n: number, ext = 'png') => `feedback/${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000.${ext}`;

/** Deterministic bytes, made a chunk at a time so a large object is never held whole here either. */
function* deterministicChunks(total: number, chunk = 256 * 1024): Generator<Buffer> {
  let produced = 0;
  let counter = 0;
  while (produced < total) {
    const size = Math.min(chunk, total - produced);
    const out = Buffer.allocUnsafe(size);
    for (let at = 0; at < size; at += 32) {
      createHash('sha256').update(`block-${counter++}`).digest().copy(out, at, 0, Math.min(32, size - at));
    }
    produced += size;
    yield out;
  }
}

function sha256Of(chunks: Iterable<Buffer>): string {
  const hash = createHash('sha256');
  for (const c of chunks) hash.update(c);
  return hash.digest('hex');
}

/** Bytes [offset, offset+length) of the deterministic stream, regenerated. */
function deterministicSlice(total: number, offset: number, length: number): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (const c of deterministicChunks(total)) {
    const start = Math.max(offset, at);
    const end = Math.min(offset + length, at + c.length);
    if (start < end) parts.push(c.subarray(start - at, end - at));
    at += c.length;
    if (at >= offset + length) break;
  }
  return Buffer.concat(parts);
}

describe('KdbObjectStorage against kdb-service', { skip }, () => {
  let dataDir: string;
  let service: ChildProcess | undefined;
  let storage: KdbObjectStorageType;
  let KdbObjectStorage: typeof import('../src/services/storage/kdb.ts').KdbObjectStorage;
  let StorageIntegrityError: typeof import('../src/services/storage/types.ts').StorageIntegrityError;

  const start = async () => {
    service = spawn(
      SERVICE_BIN,
      [
        '--data-dir', dataDir,
        '--namespace', NS,
        '--sql-addr', `tcp://127.0.0.1:${PORT}?bind=true`,
        '--peer-addr', '', '--stream-addr', '',
        '--durability', 'sync',
        '--log-level', 'error',
      ],
      { stdio: 'ignore' }
    );
    await waitForPort(PORT);
  };

  const hardKill = async () => {
    const exited = new Promise<void>((done) => service!.once('exit', () => done()));
    service!.kill('SIGKILL');
    await exited;
    service = undefined;
  };

  const open = () => new KdbObjectStorage({ addr: `tcp://127.0.0.1:${PORT}`, namespace: NS });

  before(async () => {
    process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
    dataDir = mkdtempSync(join(tmpdir(), 'qtask-kdb-storage-'));
    ({ KdbObjectStorage } = await import('../src/services/storage/kdb.ts'));
    ({ StorageIntegrityError } = await import('../src/services/storage/types.ts'));
    await start();
    storage = open();
  });

  after(async () => {
    await storage?.close();
    service?.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips binary bytes and their content type', async () => {
    const body = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
    await storage.put(key(1), body, 'image/png');
    const stored = await storage.get(key(1));
    assert.ok(stored);
    assert.equal(stored.contentType, 'image/png');
    assert.ok(stored.body.equals(body));
    const info = await storage.stat(key(1));
    assert.equal(info?.contentType, 'image/png');
    assert.equal(info?.size, 512);
    assert.match(info?.hash ?? '', /^[0-9a-f]{64}$/);
  });

  it('round-trips an object over 1 MiB (several Merkle chunks, not a multiple of one)', async () => {
    const body = randomBytes(3 * MIB + 17);
    await storage.put(key(2), body, 'image/webp');
    const stored = await storage.get(key(2));
    assert.ok(stored);
    assert.equal(stored.body.length, body.length);
    assert.ok(stored.body.equals(body));
    assert.equal(stored.contentType, 'image/webp');
    assert.equal((await storage.stat(key(2)))?.size, 3 * MIB + 17);
  });

  it('round-trips an empty object', async () => {
    await storage.put(key(3), Buffer.alloc(0), 'image/jpeg');
    const stored = await storage.get(key(3));
    assert.ok(stored, 'an empty object exists; it is not a missing one');
    assert.equal(stored.body.length, 0);
    assert.equal(stored.contentType, 'image/jpeg');
    assert.equal((await storage.stat(key(3)))?.size, 0);
  });

  it('overwrites: the new bytes and the new content type replace the old', async () => {
    await storage.put(key(4, 'jpg'), Buffer.from('first version, longer than the second'), 'image/png');
    await storage.put(key(4, 'jpg'), Buffer.from('second'), 'image/jpeg');
    const stored = await storage.get(key(4, 'jpg'));
    assert.equal(stored?.body.toString(), 'second');
    assert.equal(stored?.contentType, 'image/jpeg');
    assert.equal((await storage.stat(key(4, 'jpg')))?.size, 6);
  });

  it('keeps the last write when puts of one key race', async () => {
    const bodies = Array.from({ length: 6 }, (_, i) => Buffer.from(`racer-${i}`));
    await Promise.all(bodies.map((b) => storage.put(key(5), b, 'image/png')));
    const stored = await storage.get(key(5));
    assert.ok(stored);
    assert.ok(bodies.some((b) => b.equals(stored.body)), 'one of the racers, whole - never a mix or nothing');
  });

  it('deletes, and deleting again (or something never stored) is not an error', async () => {
    await storage.put(key(6), Buffer.from('to delete'), 'image/png');
    await storage.delete(key(6));
    assert.equal(await storage.get(key(6)), null);
    assert.equal(await storage.stat(key(6)), null);
    await storage.delete(key(6));
    await storage.delete(key(0x6666));
  });

  it('answers null for a missing object, from every read', async () => {
    assert.equal(await storage.get(key(0x7777)), null);
    assert.equal(await storage.stat(key(0x7777)), null);
    assert.equal(await storage.openRead(key(0x7777)), null);
  });

  it('refuses unsafe keys, like the other backends', async () => {
    await assert.rejects(storage.put('../escape.png', Buffer.from('x'), 'image/png'), /Invalid storage key/);
    await assert.rejects(storage.get('feedback/../../etc/passwd'), /Invalid storage key/);
  });

  it('streams a 40 MiB object up and down without holding it whole', async () => {
    const SIZE = 40 * MIB;
    const expected = sha256Of(deterministicChunks(SIZE));
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as () => void;
    gc();
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = 0;
    const sample = () => {
      gc();
      peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
    };

    async function* upload() {
      for (const chunk of deterministicChunks(SIZE)) {
        sample();
        yield chunk;
      }
    }
    await storage.putStream(key(8), upload(), 'image/png');
    const uploadPeak = peak;
    peak = 0;

    const read = await storage.openRead(key(8));
    assert.ok(read);
    assert.equal(read.size, SIZE);
    assert.equal(read.contentType, 'image/png');
    const hash = createHash('sha256');
    let received = 0;
    for await (const page of read.stream as AsyncIterable<Buffer>) {
      hash.update(page);
      received += page.length;
      sample();
    }
    assert.equal(received, SIZE);
    assert.equal(hash.digest('hex'), expected);
    // Either way memory is a constant, not the object: measured on v0.8.0 at about 4 MiB of buffers
    // for the upload and 15 MiB for the download (the same 15 MiB for 8, 40 and 64 MiB objects - the
    // client's transport buffer, not the object), where a buffered get() of a 20 MiB object measured 22 MiB.
    assert.ok(uploadPeak < SIZE / 2, `upload peak buffer growth ${(uploadPeak / MIB).toFixed(1)} MiB for a ${SIZE / MIB} MiB object`);
    assert.ok(peak < SIZE / 2, `download peak buffer growth ${(peak / MIB).toFixed(1)} MiB for a ${SIZE / MIB} MiB object`);

    // A verified ranged read from the middle, across chunk boundaries.
    const offset = 5 * MIB + 3;
    const length = 2 * MIB + 100;
    const ranged = await storage.openRead(key(8), { offset, length });
    assert.ok(ranged);
    assert.equal(ranged.size, SIZE, 'size is the whole object, not the range');
    const parts: Buffer[] = [];
    for await (const page of ranged.stream as AsyncIterable<Buffer>) parts.push(page);
    assert.ok(Buffer.concat(parts).equals(deterministicSlice(SIZE, offset, length)));
  });

  it('surfaces a damaged stored copy as a StorageIntegrityError, never as a missing file', async () => {
    const body = randomBytes(3 * MIB + 5);
    await storage.put(key(9), body, 'image/png');
    // Large blobs are standalone segment files holding the raw bytes; flip one byte in chunk 1.
    const segment = findFile(join(dataDir, 'ns'), (path) => /\/attachment\/u-/.test(path) && statSync(path).size === body.length);
    assert.ok(segment, 'the blob segment on disk');
    const fd = openSync(segment, 'r+');
    const one = Buffer.alloc(1);
    readSync(fd, one, 0, 1, MIB + 10);
    one[0] ^= 0xff;
    writeSync(fd, one, 0, 1, MIB + 10);
    closeSync(fd);

    await assert.rejects(storage.get(key(9)), (error: unknown) => {
      assert.ok(error instanceof StorageIntegrityError, `got ${(error as Error)?.name}: ${(error as Error)?.message}`);
      assert.equal(error.code, 'INTEGRITY');
      assert.equal(error.key, key(9));
      return true;
    });
    // A stream fails too - it must not end cleanly with bad or missing bytes.
    await assert.rejects(
      (async () => {
        const read = await storage.openRead(key(9));
        for await (const _ of read!.stream) void _;
      })(),
      StorageIntegrityError
    );
    await assert.rejects(storage.openRead(key(9), { offset: MIB, length: 100 }).then(async (read) => {
      for await (const _ of read!.stream) void _;
    }), StorageIntegrityError);
    // The metadata is intact and still says the object exists.
    assert.equal((await storage.stat(key(9)))?.size, body.length);
    await storage.delete(key(9));
  });

  it('keeps every acknowledged put and delete across kill -9 and a restart', async () => {
    const big = randomBytes(2 * MIB + 1);
    await storage.put(key(10), big, 'image/webp');
    await storage.put(key(11), Buffer.from('small'), 'image/png');
    await storage.put(key(12), Buffer.from('gone'), 'image/png');
    await storage.delete(key(12));
    await storage.put(key(13), Buffer.from('v1'), 'image/png');
    await storage.put(key(13), Buffer.from('v2'), 'image/jpeg');

    await storage.close();
    await hardKill();
    await start();
    storage = open();

    const reBig = await storage.get(key(10));
    assert.ok(reBig?.body.equals(big));
    assert.equal(reBig?.contentType, 'image/webp');
    assert.equal((await storage.get(key(11)))?.body.toString(), 'small');
    assert.equal(await storage.get(key(12)), null, 'a delete must not come back');
    const v = await storage.get(key(13));
    assert.equal(v?.body.toString(), 'v2');
    assert.equal(v?.contentType, 'image/jpeg');
    // Written before the earlier tests' restart-free run, still there too.
    assert.equal((await storage.get(key(2)))?.body.length, 3 * MIB + 17);
    assert.equal((await storage.get(key(3)))?.body.length, 0);
  });

  it('reconnects after the server restarts under an open storage handle', async () => {
    await storage.put(key(14), Buffer.from('before'), 'image/png');
    await hardKill();
    await start();
    // The first call may fail on the dead connection; the next one opens a new connection.
    await storage.get(key(14)).catch(() => undefined);
    assert.equal((await storage.get(key(14)))?.body.toString(), 'before');
  });
});

describe('KdbObjectStorage error mapping (no server)', () => {
  it('turns a client-side integrity failure into StorageIntegrityError, and not-found into null', async () => {
    const { KdbObjectStorage } = await import('../src/services/storage/kdb.ts');
    const { StorageIntegrityError } = await import('../src/services/storage/types.ts');
    const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(name), { name, ...extra });
    let failWith: Error = named('KdbIntegrityError', { code: 'INTEGRITY' });
    const client = {
      readAttachment: async () => { throw failWith; },
      listAttachments: async () => { throw failWith; },
      close: async () => undefined,
    } as unknown as import('../src/services/storage/kdb.ts').KdbAttachmentClient;
    const storage = new KdbObjectStorage({ addr: 'unused', namespace: 'unused', client });

    await assert.rejects(storage.get(key(1)), StorageIntegrityError);
    failWith = named('KdbAttachmentCorruptError', { code: 'INTEGRITY' });
    await assert.rejects(storage.get(key(1)), StorageIntegrityError);
    failWith = named('KdbAttachmentNotFoundError');
    assert.equal(await storage.get(key(1)), null);
    failWith = named('KdbNotFoundError');
    assert.equal(await storage.stat(key(1)), null);
    // Anything else passes through unchanged, as the other backends let errors through.
    failWith = named('KdbUnavailableError', { code: 'UNAVAILABLE' });
    await assert.rejects(storage.get(key(1)), (error: Error) => error === failWith);
  });
});

function findFile(dir: string, match: (path: string) => boolean): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, match);
      if (found) return found;
    } else if (match(path)) {
      return path;
    }
  }
  return undefined;
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((done) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => done(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`kdb-service did not open port ${port}`);
}
