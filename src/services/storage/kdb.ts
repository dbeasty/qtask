/**
 * Object storage on KDB attachments (STORAGE_BACKEND=kdb, KDB v0.8.0+).
 *
 * Each stored object is one record plus one attachment:
 *
 *  - The record is `{ _c: 'files', key, updatedAt }`, at a document id derived from the storage
 *    key (`toDocumentUuid('file:' + key)`, a hash). Every operation is therefore a keyed read or
 *    write of one document - nothing scans - and the id space cannot meet the data layer's: a
 *    hashed id always has a non-zero first byte, a padded ObjectId never does, and the `file:`
 *    prefix keeps it apart from collections with string ids. `_c: 'files'` is a value no
 *    collection uses, so the data layer's `WHERE _c = ?` scans never see these records.
 *  - The bytes are that record's attachment named `content`, with a fixed id derived from the key,
 *    so a put never has to look the attachment up first. Its media type and size live on the
 *    attachment, not the record: they change together with the bytes, in the same commit.
 *
 * A dedicated record per file, rather than hanging files off the record that refers to them (a
 * feedback document), because the storage interface is addressed by key alone and its callers
 * write the referring document separately and later: the bytes are stored before the feedback
 * exists, and are deleted by key when it goes. Hanging them off the feedback would couple storage
 * to one caller's schema and make every get a lookup.
 *
 * Writes upload the bytes first (streamed in 1 MiB chunks, hashed as they go and checked against
 * the server's content hash), then commit the record and the attachment reference together. A
 * file's first put needs one extra commit to create the record, because a transaction needs a
 * base commit and there is none to read for a document that does not exist yet; a crash between
 * the two leaves a record with no attachment, which reads as absent - exactly as if the put had
 * failed. Deleting the record deletes its attachment in the same commit.
 *
 * Reads are verified: a whole read checks every byte against the Merkle content hash before the
 * last page is handed over, and a ranged read checks each 1 MiB chunk it touches with an inclusion
 * proof. A mismatch, or the server refusing its own damaged copy, is a StorageIntegrityError -
 * never a null, which a caller would take for a missing file.
 *
 * What it does not do: reclaim space on delete or overwrite. KDB keeps attachment history by
 * default (replaced versions are re-stored as deltas), so storage grows with every version until
 * history is truncated. See docs/KDB_MIGRATION.md.
 */

import { Readable } from 'node:stream';
import { toDocumentUuid } from '../../data/kdb/ids.js';
import { assertSafeStorageKey, StorageIntegrityError, type ObjectStorage, type StoredObject } from './types.js';

/** The record type of a stored file, in the `_c` discriminator the data layer uses. */
export const FILES_COLLECTION = 'files';
/** The one attachment each file record carries. */
export const CONTENT_ATTACHMENT = 'content';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
/** Puts retried after losing a race on the same key to another process (puts in this one take
 *  turns, see `write`). The bytes are uploaded once. */
const MAX_COMMIT_ATTEMPTS = 8;

interface AttachmentInfo {
  id: string;
  name: string;
  hash: string;
  size: number;
  mime: string;
}

interface AttachmentReader extends AsyncIterable<Uint8Array> {
  readonly info: AttachmentInfo;
  cancel(): Promise<void>;
}

interface AttachmentPutOp {
  kind: 'put';
  docId: string;
  id: string;
  name: string;
  hash: string;
  size: number;
  mime?: string;
}

type AttachmentSource = Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/** The part of `@limidus/kdb-client` this backend uses, so the module can be loaded (or faked) at runtime. */
export interface KdbAttachmentClient {
  get(ns: string, docId: string): Promise<{ body: unknown; commit: string }>;
  replace(ns: string, docId: string, body: unknown): Promise<string>;
  delete(ns: string, docId: string): Promise<string>;
  commit(tx: {
    namespace: string;
    baseVersion: string;
    writes: Array<{ docId: string; body: unknown; replace?: boolean }>;
    attachments?: AttachmentPutOp[];
  }): Promise<string>;
  prepareAttachment(
    ns: string,
    docId: string,
    data: AttachmentSource,
    options: { id: string; name: string; mime: string }
  ): Promise<AttachmentPutOp>;
  listAttachments(ns: string, docId: string): Promise<AttachmentInfo[]>;
  readAttachment(ns: string, docId: string, selector: string): Promise<{ info: AttachmentInfo; data: Uint8Array }>;
  getAttachment(ns: string, docId: string, selector: string): Promise<AttachmentReader>;
  openAttachmentRange(
    ns: string,
    docId: string,
    selector: string,
    options: { offset: number; length: number }
  ): Promise<AttachmentReader>;
  close(): Promise<void>;
}

export interface KdbStorageConfig {
  /** Wire address of the KDB server, e.g. tcp://127.0.0.1:7700. */
  addr: string;
  namespace: string;
  /** "user:secret" for a server with access control; empty for none. */
  token?: string;
  /** Per-request deadline; KDB_REQUEST_TIMEOUT_MS by default, else the client's 30 s. */
  requestTimeoutMs?: number;
  /** Supplies the client instead of connecting to `addr` (tests). */
  client?: KdbAttachmentClient;
}

/** What `stat` reports: the attachment's metadata, without reading its bytes. */
export interface StoredObjectInfo {
  contentType: string;
  size: number;
  /** KDB's content hash (scheme 1: a Merkle root over 1 MiB SHA-256 chunks), lowercase hex. */
  hash: string;
}

/** An object being read: its metadata now, its bytes as a stream. */
export interface StoredObjectStream {
  contentType: string;
  /** The whole object's size, whatever range is being read. */
  size: number;
  stream: Readable;
}

export class KdbObjectStorage implements ObjectStorage {
  private connecting?: Promise<KdbAttachmentClient>;
  /** The last commit of each key's put still in flight in this process (see `write`). */
  private readonly turns = new Map<string, Promise<unknown>>();

  constructor(private readonly options: KdbStorageConfig) {
    if (options.client) this.connecting = Promise.resolve(options.client);
  }

  get namespace(): string {
    return this.options.namespace;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.write(key, body, contentType);
  }

  /**
   * `put` from a stream: the bytes go up in 1 MiB chunks as they arrive and are never held whole,
   * so an object of any size costs a few MiB of memory. A Node Readable is an async iterable of
   * Buffers, so it can be passed as is.
   */
  async putStream(key: string, source: AsyncIterable<Uint8Array>, contentType: string): Promise<void> {
    await this.write(key, source, contentType);
  }

  async get(key: string): Promise<StoredObject | null> {
    const ids = fileIds(key);
    const client = await this.client();
    try {
      const { info, data } = await client.readAttachment(this.namespace, ids.docId, CONTENT_ATTACHMENT);
      return {
        body: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        contentType: info.mime || DEFAULT_CONTENT_TYPE,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw this.mapError(key, error);
    }
  }

  /** The object's type, size and content hash, or null when there is none. Reads no bytes. */
  async stat(key: string): Promise<StoredObjectInfo | null> {
    const ids = fileIds(key);
    const client = await this.client();
    try {
      const items = await client.listAttachments(this.namespace, ids.docId);
      const content = items.find((item) => item.name === CONTENT_ATTACHMENT);
      if (!content) return null;
      return { contentType: content.mime || DEFAULT_CONTENT_TYPE, size: content.size, hash: content.hash };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw this.mapError(key, error);
    }
  }

  /**
   * Opens a streamed read, or null when there is no such object. Without a range the whole object
   * is read and verified against its content hash before its last bytes are released; with one,
   * `length` bytes from `offset` (length -1 or omitted: to the end) are read, each 1 MiB chunk
   * verified with its Merkle inclusion proof before any of it is released. Either way a damaged
   * copy fails the stream with a StorageIntegrityError, and memory does not grow with the object.
   */
  async openRead(key: string, range?: { offset: number; length?: number }): Promise<StoredObjectStream | null> {
    const ids = fileIds(key);
    const client = await this.client();
    let reader: AttachmentReader;
    try {
      reader = range
        ? await client.openAttachmentRange(this.namespace, ids.docId, CONTENT_ATTACHMENT, {
            offset: range.offset,
            length: range.length ?? -1,
          })
        : await client.getAttachment(this.namespace, ids.docId, CONTENT_ATTACHMENT);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw this.mapError(key, error);
    }
    const mapError = (error: unknown) => this.mapError(key, error);
    async function* pages(): AsyncGenerator<Buffer> {
      try {
        for await (const page of reader) yield Buffer.from(page.buffer, page.byteOffset, page.byteLength);
      } catch (error) {
        throw mapError(error);
      }
    }
    const stream = Readable.from(pages(), { objectMode: false });
    // A consumer that stops early (a client hanging up) must not leave the server holding the read.
    stream.once('close', () => {
      if (!stream.readableEnded) void reader.cancel().catch(() => undefined);
    });
    return { contentType: reader.info.mime || DEFAULT_CONTENT_TYPE, size: reader.info.size, stream };
  }

  async delete(key: string): Promise<void> {
    const ids = fileIds(key);
    const client = await this.client();
    try {
      // One commit removes the record and, with it, its attachment. Deleting an absent document
      // is not an error, which is the idempotence the other backends have.
      await client.delete(this.namespace, ids.docId);
    } catch (error) {
      throw this.mapError(key, error);
    }
  }

  async close(): Promise<void> {
    const pending = this.connecting;
    this.connecting = undefined;
    if (!pending) return;
    const client = await pending.catch(() => undefined);
    await client?.close().catch(() => undefined);
  }

  private async write(key: string, source: AttachmentSource, contentType: string): Promise<void> {
    const ids = fileIds(key);
    const client = await this.client();
    const ns = this.namespace;
    try {
      // Bytes first: nothing references them until the commit below, and the server collects an
      // upload no commit claims (after --attachment-upload-grace), so a failure here leaves nothing.
      const op = await client.prepareAttachment(ns, ids.docId, source, {
        id: ids.attachmentId,
        name: CONTENT_ATTACHMENT,
        mime: contentType,
      });
      await this.inTurn(ids.docId, () => this.commitRecord(client, key, ids, op));
    } catch (error) {
      throw this.mapError(key, error);
    }
  }

  /**
   * Runs puts of one key one after another in this process. Racing, they all read the same base,
   * one commit wins and the rest conflict and go round again in lockstep - one more loser each
   * round - so with enough of them the last ran out of attempts (seen as a flaky test under load).
   * Taking turns, each commits on its predecessor's head. Only the commit takes a turn; uploads
   * still overlap. Other processes are what the conflict retry is left for.
   */
  private async inTurn<T>(docId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.turns.get(docId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.turns.set(docId, settled);
    try {
      return await run;
    } finally {
      if (this.turns.get(docId) === settled) this.turns.delete(docId);
    }
  }

  private async commitRecord(client: KdbAttachmentClient, key: string, ids: ReturnType<typeof fileIds>, op: Awaited<ReturnType<KdbAttachmentClient['prepareAttachment']>>): Promise<void> {
    const ns = this.namespace;
    const record = { _c: FILES_COLLECTION, key, updatedAt: new Date().toISOString() };
    let lastConflict: unknown;
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      // Spread the retries out: writers that collided and retry at once collide again.
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(200, 10 * 2 ** attempt)));
      let base: string;
      try {
        base = (await client.get(ns, ids.docId)).commit;
      } catch (error) {
        if (!isNotFound(error)) throw error;
        base = await client.replace(ns, ids.docId, record);
      }
      try {
        await client.commit({
          namespace: ns,
          baseVersion: base,
          writes: [{ docId: ids.docId, body: record, replace: true }],
          attachments: [op],
        });
        return;
      } catch (error) {
        // Another put (or a delete) of the same key committed since `base`: the later writer
        // wins, as on a file system or S3, so read the new base and commit again.
        if (!isConflict(error)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict;
  }

  private client(): Promise<KdbAttachmentClient> {
    if (!this.connecting) {
      const attempt = connectClient(this.options);
      this.connecting = attempt;
      // A failed connect is not cached: the next call tries again.
      attempt.catch(() => {
        if (this.connecting === attempt) this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private mapError(key: string, error: unknown): unknown {
    if (error instanceof StorageIntegrityError) return error;
    if (isIntegrity(error)) return new StorageIntegrityError(key, { cause: error });
    // A dead connection is not coming back; the next call opens a new one.
    if (isConnectionLost(error) && !this.options.client) {
      const stale = this.connecting;
      this.connecting = undefined;
      void stale?.then((client) => client.close()).catch(() => undefined);
    }
    return error;
  }
}

/** The record and attachment ids of a storage key. Exported for tests. */
export function fileIds(key: string): { docId: string; attachmentId: string } {
  assertSafeStorageKey(key);
  return {
    docId: toDocumentUuid(`file:${key}`),
    attachmentId: toDocumentUuid(`file-content:${key}`),
  };
}

async function connectClient(options: KdbStorageConfig): Promise<KdbAttachmentClient> {
  const specifier = process.env.KDB_CLIENT_MODULE ?? '@limidus/kdb-client';
  let module: { connect?: (addr: string, options: object) => Promise<KdbAttachmentClient> };
  try {
    module = (await import(specifier)) as typeof module;
  } catch (error) {
    throw new Error(
      `STORAGE_BACKEND=kdb requires the KDB client. Could not load "${specifier}": ${(error as Error).message}. ` +
        'Set KDB_CLIENT_MODULE to its location, or install @limidus/kdb-client.'
    );
  }
  if (typeof module.connect !== 'function') throw new Error(`${specifier} does not export connect()`);
  const envTimeout = Number(process.env.KDB_REQUEST_TIMEOUT_MS);
  const timeout = options.requestTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : undefined);
  return module.connect(options.addr, {
    ...(options.token ? { token: options.token } : {}),
    ...(timeout ? { requestTimeoutMs: timeout } : {}),
  });
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { name?: string }).name : undefined;
}

/** KdbNotFoundError, or its subclass KdbAttachmentNotFoundError (the record has no such attachment). */
function isNotFound(error: unknown): boolean {
  const name = errorName(error);
  return name === 'KdbNotFoundError' || name === 'KdbAttachmentNotFoundError';
}

/**
 * KdbAttachmentCorruptError (the server refused to serve its damaged copy: wire code INTEGRITY), or
 * its subclass KdbIntegrityError (this client's own verification of the bytes failed).
 */
function isIntegrity(error: unknown): boolean {
  const name = errorName(error);
  return (
    name === 'KdbAttachmentCorruptError' ||
    name === 'KdbIntegrityError' ||
    (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'INTEGRITY')
  );
}

function isConflict(error: unknown): boolean {
  return errorName(error) === 'KdbConflictError';
}

function isConnectionLost(error: unknown): boolean {
  const name = errorName(error);
  return name === 'KdbClosedError' || name === 'KdbTransportError';
}
