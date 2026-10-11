# src/sync — application-level sync engine (Phase 2)

Status: interface-first draft, committed early so Phase 1 (`src/local/`) and Phase 3
(LAN/BLE transports) can code against it. Branch: `worktree-agent-afd3ddba006404c04`.

This does **not** depend on KDB peer sync or its multi-namespace runtime. It sits on
the backend-agnostic `DataStore` (`src/data`), works over Mongo, KDB or the in-memory
store, and treats the cloud as one more peer.

## Model

* Every device/process has a **node id** (`SyncEngine.nodeId`, persisted in the meta
  store) and a **hybrid logical clock** (`HLC`, `clock.ts`). Timestamps are strings
  `wall(15 digits)-counter(hex 6)-nodeId`, so plain string comparison is a total
  order consistent with causality.
* Replicated collections: `tasks projects comments activities conversations
  notifications`. **Never replicated:** `users`, sessions (`mcpSessions`), OAuth
  tokens/codes (`mcp*`, `userOAuthAuthCodes`), `embedding` fields and
  `embeddingJobs`, LLM metrics, `adminAudits`, `feedback*`, `invites`, API keys.
* Each document has a **sync record** (kept beside the data, not inside it): one
  stamp `{t, c}` per top-level field, a per-document version vector `vv`, an optional
  tombstone stamp, a local change sequence `seq` and the `scope` it belongs to
  (`u:<userId>` or `p:<projectId>`).
* **Deletes are tombstones in the sync record.** The `SyncDataStore` wrapper sees
  every `deleteOne/deleteMany/findOneAndDelete` (including cascades) and records a
  tombstone; services keep calling the normal API. A tombstone beats an older edit;
  a newer edit (re-create) beats an older tombstone.
* **Merge** is field level. Same field changed on both sides (neither side's dot is
  in the other's `vv`): later HLC wins, the loser is written to the `activities`
  collection (`action: 'sync_conflict'`, `source: 'system'`) and the engine's sync
  log. Derived fields (`percentComplete`, `progressShare`, `trackingRollup`,
  `updatedAt`, `embedding`) are never merged; after a merge they are recomputed by
  the registered `DerivedRecompute` hooks.
* **Delta exchange** is cursor based and idempotent: each side keeps, per peer, the
  last `seq` it pushed and the last peer `seq` it pulled. Applying a document twice
  is a no-op. A changed peer `epoch` (its meta was reset) resets the cursors.

## Public API (stable surface for other phases)

```ts
import {
  SyncEngine, SyncDataStore, MemoryMetaStore, HttpSyncTransport,
  LoopbackTransport, DeviceSyncClient, adoptLocalAccount, createSyncRouter,
} from './sync/index.js';

// 1. wrap the store services use
const meta    = new MemoryMetaStore();
const tracked = new SyncDataStore(innerStore, meta);   // implements DataStore
const engine  = new SyncEngine({ store: tracked, meta, role: 'device' /* | 'hub' */ });
await engine.init();

// 2. one sync round with any peer
const result = await engine.syncWith(transport);       // { pulled, pushed, conflicts, ... }
await engine.status();                                 // { nodeId, pendingChanges, lastSyncedAt, peers[] }

// 3. serve a peer (hub route, LAN listener, BLE tunnel all call this)
const svc = engine.service(authorizer);                // SyncService
await svc.hello(req); await svc.pull(peerId, req); await svc.push(peerId, req);
```

### `SyncTransport` — what Phase 3 implements

```ts
interface SyncTransport {
  readonly kind: string;                       // 'http' | 'lan' | 'ble' | 'loopback'
  hello(req: HelloRequest): Promise<HelloResponse>;
  pull(req: PullRequest): Promise<PullResponse>;
  push(req: PushRequest): Promise<PushResponse>;
  close?(): Promise<void>;
}
```
All request/response types are plain JSON (`types.ts`; `WireDoc` carries encoded
values, dates as `{"$date": iso}`), so any framing (HTTP, TLS socket, BLE tunnel) can
carry them unchanged. A LAN/BLE listener is: parse frame -> `engine.service(auth)`
method -> serialise reply. Peers are fully trusting (`authorizer` omitted) only
after pairing; the hub passes `HubAuthorizer` (per-user scope + collaborator roles).

### Cloud hub routes (`createSyncRouter`, mounted at `/api/sync`, behind `requireAuth`)

`POST /hello`, `POST /pull`, `POST /push`, `GET /status`. Scope: the caller's own
`u:` scope plus every project (`p:`) they own or collaborate on. Push is rejected
per document for out-of-scope documents, for `viewer`s, and for role-restricted
changes (`executor` may only change task status/progress fields; `collaborators`
and project structure need owner/manager).

### Device client

`DeviceSyncClient({ engine, hubUrl, getToken })` - `start()/stop()`, `syncNow()`,
`status()` -> `{ state, lastSyncedAt, lastError, pendingChanges, nextRetryAt }`.
Dials out only when a token exists; exponential backoff with jitter on failure.
`adoptLocalAccount(engine, localUserId, accountUserId)` re-owns local documents on
first sign-in.

## Files

`clock.ts` HLC · `codec.ts` value encoding/hash · `policy.ts` what replicates ·
`meta.ts` sync records · `tracker.ts` `SyncDataStore` · `merge.ts` three-way field
merge · `engine.ts` capture/apply/delta · `transport.ts` · `hub.ts` · `client.ts` ·
`adopt.ts` · `derived.ts`.
