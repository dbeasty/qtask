# src/sync — application-level sync engine (Phase 2)

Status: implemented and tested (see `tests/sync-*.test.ts`, `docs/perf/phase2.md`).
The interface below was committed first so Phase 1 (`src/local/`) and Phase 3 (LAN/BLE
transports) could code against it. Branch: `worktree-agent-afd3ddba006404c04`.

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
  tombstone; services keep calling the normal API and the document is still removed
  from the data store, so no read path needs a `deletedAt` filter. **Delete wins**
  over a concurrent edit, whichever is later, and a deleted id stays deleted
  (application ids are never reused). Tombstones are never purged yet (plan Phase 5).
* **Merge** is field level over top-level fields (arrays and sub-objects such as
  `steps`, `subtasks`, `tags` are atomic values). Same field changed on both sides
  (neither side's dot is in the other's `vv`): later HLC wins, the loser is written to the `activities`
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

## Transports

* `src/sync/lan/`: Wi-Fi (pinned mutual TLS, mDNS, QR/six-digit pairing). `docs/sync-lan-transport.md`.
* `src/sync/ble/`: Bluetooth LE (Phase 4): a tunnel (X25519 + Ed25519 signatures from the existing pairing records + ChaCha20-Poly1305) over unpaired GATT links, a `BleTransport`, a `TransportSelector` that prefers Wi-Fi, a simulated radio and a JSON bridge to the Mac app's CoreBluetooth. `docs/sync-ble-transport.md`, measurements in `docs/perf/phase4.md`. **Never run on a real radio.**
* `LanSyncCoordinator` (`lan/rpc.ts`) runs the engine over any `PeerLinkTransport`, including the selector; `shouldInitiate` lets only one end start the round on a scarce link.

## Files

`clock.ts` HLC · `codec.ts` value encoding/hash · `policy.ts` what replicates ·
`meta.ts` sync records · `tracker.ts` `SyncDataStore` · `merge.ts` three-way field
merge · `engine.ts` capture/apply/delta · `transport.ts` · `hub.ts` · `client.ts` ·
`adopt.ts` · `derived.ts`.

## Wiring

* Cloud: `QTASK_SYNC_HUB=true` makes `connectData()` wrap the store with
  `SyncDataStore` and register the hub engine; `/api/sync/*` is mounted in
  `src/app.ts`. `QTASK_SYNC_META_PATH=/path/meta.json` persists the sync records
  (debounced atomic JSON snapshot); without it a restart re-baselines every document.
* Device (Phase 1): build `MemoryMetaStore`/`FileMetaPersistence.open(path)`,
  `new SyncDataStore(localStore, meta)` and hand **that** store to the services, then
  `new SyncEngine({store, meta, role: 'device', derived: createDefaultDerived()})`,
  `await engine.init()` (baselines existing local data), and a `DeviceSyncClient`.
  On sign-in call `adoptLocalAccount(engine, localUserId, accountUserId)` once, then
  `client.syncNow()`.
* `SyncResult.conflicts` counts conflicts found while *applying pulled* documents;
  conflicts the hub finds while applying a push are in the hub's log and, after the
  next pull, in the device's `activities` (`action: 'sync_conflict'`).

## Service audit (plan 5.3 / 5.5)

| Finding | Where | Handling |
|---|---|---|
| Hard deletes of tasks/comments (incl. cascades) | `taskService` (delete, promote, move-subtask), `projectService.deleteProject`, `commentService`, `conversationService`, `authService` rollback | Captured by `SyncDataStore` -> tombstone in the sync record. No service change was needed; the document is still removed from the store. |
| Staged agent proposals deleted on rollback/expiry | `stagingService` | Docs with `staging` set are never replicated and leave no tombstone; they replicate once committed. |
| Derived fields | `percentComplete` (tasks, projects), project `status`, `trackingRollup` | Excluded from stamps; recomputed after merge by `DerivedRecompute` (`derived.ts`, same pure util functions as the services). |
| `progressShare` | tasks, projects | An input weight, so it **is** replicated (LWW). Only the normalised/effective share is derived, at read time. |
| `$inc sortOrder` on siblings | `taskService.promoteSubtask` | Becomes per-task `sortOrder` LWW edits; concurrent reorders on two devices can leave ties, not lost tasks. Not recomputed. |
| `$push` onto `conversation.messages` | `conversationService.appendMessages` | `messages` is one LWW field, so two devices appending to the same conversation offline keep only the later side (logged as a conflict). Messages have no ids, so a union merge is not possible without a schema change. |
| `$inc attempts`, LLM counters | `embeddingQueue`, `feedbackVisionQueue`, `llmMetrics` | Local-only collections; never replicated. |
| Embeddings | `embedding` on tasks/projects | Never replicated; `afterApply` queues a local rebuild on the receiver. |
| Id collisions offline | ObjectId-shaped ids with a per-process random part | Collision-free for practical purposes; the engine also never trusts an id to be unique across owners (see `HubAuthorizer`). |

## Known limits

* Merge granularity is the top-level field. Concurrent edits to different elements of
  one array (two new `steps`) conflict as a whole; the later side wins and the loser is
  logged.
* A rejected push (role violation) leaves the change on the device; the device sees it
  in `SyncResult.rejected` and the log, but nothing reverts it.
* Tasks moved out of a shared project are not removed from collaborators' devices.
* Sync records are in memory plus a JSON snapshot; the hub without
  `QTASK_SYNC_META_PATH` loses cursors and stamps on restart.
* `updatedAt` is not replicated (the backend stamps it on write); sync keeps its own
  `ut` per record.
