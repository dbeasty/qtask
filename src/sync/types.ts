/**
 * Types shared by the sync engine, its transports and the hub routes.
 * Everything that crosses a transport is plain JSON.
 */

import type { CollectionName } from '../data/types.js';

/** Collections that replicate. Everything else is local-only (see policy.ts). */
export type ReplicatedCollection =
  | 'projects'
  | 'tasks'
  | 'comments'
  | 'activities'
  | 'conversations'
  | 'notifications';

export type { CollectionName };

/** A field's write: stamp `t` (HLC string) and `c`, the writer's per-document counter. */
export interface WireField {
  /** Encoded value (dates as `{"$date": iso}`). Absent when `x` is set. */
  v?: unknown;
  /** The field was removed. */
  x?: 1;
  t: string;
  c: number;
}

export interface WireTombstone {
  t: string;
  c: number;
}

export interface WireDoc {
  coll: ReplicatedCollection;
  id: string;
  /** `u:<userId>` or `p:<projectId>`. */
  scope: string;
  /** Live fields only; fields older than the tombstone are not sent. */
  fields: Record<string, WireField>;
  /** Version vector: highest per-document counter seen from each node. */
  vv: Record<string, number>;
  del?: WireTombstone;
}

/**
 * A document's identity and version vector, without its content. Peers exchange these
 * first so a document one side already has is never sent again (see `headersFirst`).
 */
export interface WireHeader {
  coll: ReplicatedCollection;
  id: string;
  vv: Record<string, number>;
  del?: WireTombstone;
}

export const PROTOCOL_VERSION = 1;

export interface HelloRequest {
  protocol: number;
  nodeId: string;
  epoch: string;
}

export interface HelloResponse {
  protocol: number;
  nodeId: string;
  epoch: string;
  role: 'hub' | 'device';
  /** Authenticated principal on the hub, when there is one. */
  userId?: string;
}

export interface PullRequest {
  /** Requester's node id, so the server can skip documents that came from it. */
  from: string;
  /** Server-side change sequence already received. */
  cursor: number;
  limit: number;
  /** Scope signature the cursor was issued under; a mismatch restarts from 0. */
  sig?: string;
  /** Answer with `headers` only (no content). A peer that ignores this sends `docs`. */
  headersOnly?: boolean;
  /** Instead of a cursor page, send exactly these documents (the ones `headers` said were needed). */
  ids?: Array<{ coll: ReplicatedCollection; id: string }>;
}

export interface PullResponse {
  docs: WireDoc[];
  /** Cursor to send next time. */
  next: number;
  more: boolean;
  /** Signature of the scopes this response covers. Send it back with the next pull. */
  sig: string;
  /** Present instead of `docs` content when the request was `headersOnly`. */
  headers?: WireHeader[];
}

export interface PushRequest {
  from: string;
  docs: WireDoc[];
  /**
   * More batches of the same push follow. The receiver defers its derived-field
   * recomputation to the last batch instead of rebuilding project rollups once per
   * batch, which would make a large initial sync quadratic.
   */
  more?: boolean;
  /**
   * Offer only: `docs` is empty and `offer` lists what the sender would push. The
   * receiver answers with `need`; the sender then pushes just those. A receiver that
   * does not know offers applies nothing and returns no `need`, and the sender
   * falls back to a plain push.
   */
  offer?: WireHeader[];
}

export interface PushRejection {
  coll: string;
  id: string;
  reason: string;
}

export interface PushResponse {
  accepted: number;
  rejected: PushRejection[];
  /** For an offer: `coll:id` of the documents the receiver wants. */
  need?: string[];
}

/**
 * How two peers talk. Implemented by HTTP (cloud hub), loopback (tests, in-process)
 * and, in Phase 3, Wi-Fi and Bluetooth tunnels. A transport only moves JSON.
 */
export interface SyncTransport {
  readonly kind: string;
  hello(req: HelloRequest): Promise<HelloResponse>;
  pull(req: PullRequest): Promise<PullResponse>;
  push(req: PushRequest): Promise<PushResponse>;
  close?(): Promise<void>;
}

/** Decides what a given peer may read and write. Omitted for fully trusted peers. */
export interface SyncAuthorizer {
  /** Scopes the peer may pull. */
  readableScopes(): Promise<Set<string>>;
  /** `null` to allow, otherwise a reason. `existing` is the receiver's current doc. */
  checkWrite(
    incoming: WireDoc,
    existing: Record<string, unknown> | null,
    changedFields: string[]
  ): Promise<string | null>;
  /** Principal reported in `hello`. */
  userId?: string;
}

export interface ConflictRecord {
  coll: ReplicatedCollection;
  id: string;
  field: string;
  kept: { t: string; value: unknown };
  discarded: { t: string; value: unknown };
}

export interface SyncResult {
  peerId: string;
  pulled: number;
  pushed: number;
  /** Documents the peer refused. */
  rejected: PushRejection[];
  conflicts: number;
  rounds: number;
  durationMs: number;
}

export interface PeerStatus {
  peerId: string;
  epoch: string;
  /** Last local `seq` pushed to the peer. */
  pushedSeq: number;
  /** Last peer `seq` pulled from it. */
  pulledSeq: number;
  lastSyncedAt?: string;
  pendingChanges: number;
}

export interface SyncStatus {
  nodeId: string;
  role: 'hub' | 'device';
  /** Local changes not yet captured plus captured but not yet pushed to every known peer. */
  pendingChanges: number;
  lastSyncedAt?: string;
  documents: number;
  tombstones: number;
  peers: PeerStatus[];
}

export type SyncLogEntry =
  | { at: string; kind: 'conflict'; peerId: string; conflict: ConflictRecord }
  | { at: string; kind: 'rejected'; peerId: string; rejection: PushRejection }
  | { at: string; kind: 'sync'; peerId: string; pulled: number; pushed: number };
