# Evaluation: `@kdb/replica` (KDB v0.8.0) against qtask's device sync

Status: evaluation, October 2026. Nothing in the app changes because of it. The spike it cites is
`scripts/spikes/kdb-replica-spike.ts`.

**Recommendation in one line:** keep qtask's own sync engine. `@kdb/replica` does not replace it: it
has no device-to-device transport, no Swift or React Native client, and no field-level merge. It
would also go around qtask's validation and authorization. Look at it again for one narrow use, a
browser or Node client that reads a user's data from the cloud. That makes sense once the cloud
runs on KDB (migration Stage 4+) and the conditions in section 6 hold.

## 1. What each one is

**qtask device sync** (`src/sync/`, about 9k LOC; `src/local/sync.ts`; README in `src/sync/README.md`)
- **Layer.** It is application-level and backend-agnostic. `SyncDataStore` wraps any `DataStore`
  (Mongo, KDB or memory) and marks documents dirty. The engine then diffs each top-level field
  against a per-document sync record.
- **Records.** Each field carries an HLC stamp and a counter, and each document carries a version
  vector. Records are kept in a JSON snapshot beside the data: `<dataDir>/sync/meta.json`, written
  atomically and fsynced on devices.
- **Merge.** Field-level three-way merge where the higher HLC wins. Losing values are logged as
  `sync_conflict` activities.
- **Deletes.** A delete wins over a concurrent edit.
- **Derived fields.** Fields such as progress and rollups are not synced; each side recomputes them.
- **Peers.** Devices pair by QR code or 6-digit code (Ed25519 identities, pinned TLS) and sync:
  - over the LAN: mutual TLS 1.3, own mDNS;
  - over Bluetooth: own GATT tunnel, X25519/ChaCha20, radio bridged by the Swift app;
  - to the cloud hub: HTTP, `QTASK_SYNC_HUB=true`.
- **Hub authorization.** The hub checks every pushed document against qtask's project roles.

**`@kdb/replica` 0.1.0** (KDB repo `packages/kdb-replica`, about 5.7k LOC incl. a 1k-line zstd
decoder; plan in `docs/kdb-client-replica-plan.md`, marked "Status: design")
- **What it is.** A client-side copy of KDB namespaces that syncs with one Go KDB node over peer
  sync v2, over WebSocket (`--peer-http`, path `/kdb/sync`). The replica serves nothing itself.
- **Full mode.** Holds the whole namespace with verified commits.
  - Empty replicas bootstrap from a snapshot.
  - Catch-up is by replay or by squash. Squash is refused for namespaces with attachments.
  - Push goes first; the host merges, the replica never does.
- **Filtered mode.** Holds what a client-supplied SQL filter selects and the token may read.
  - It can write back through a durable outbox, with optimistic concurrency per document.
- **Live updates.** Through `REFS_WATCH`.
- **Attachments.** Fetched lazily into a bounded LRU blob cache.
- **Reads.** Local `get` by id and `scan` by id range only. No SQL, no query engine and no
  secondary indexes (the plan promised them; they are not in the source).
- **Storage.** `MemoryStore`, `IndexedDbStore` or a custom `KvStore`. There is no on-disk Node
  store.
- **Runtime.** Node ≥ 22 or browsers. Licensed AGPL-3.0-or-later, like `@limidus/kdb-client`.

## 2. Spike: a replica of qtask's own data

`scripts/spikes/kdb-replica-spike.ts` starts an on-disk `kdb-service` v0.8.0 with `--peer-http`.
It seeds 5,000 tasks and 20 projects through qtask's `KdbDataStore` and then drives the replica
from the v0.8.0 source tag (`MemoryStore`, no auth). It ran once, on this development Mac, over loopback.
These are single-run timings; read them as orders of magnitude.

| Step | Result |
|---|---|
| Full bootstrap (snapshot), 5,020 docs | 158 ms |
| Catch-up after 500 edits made through qtask | route `replay`, 500 changed, 57 ms |
| No-op round | 2 ms |
| Replica writes one task, pushes | `fast-forwarded`, 339 ms; qtask's store reads the new title |
| Same task edited concurrently (replica: `title`, qtask: `status`) | push outcome `conflict`, one `conflict` event; the server keeps qtask's version; the replica's commit stays pending |
| Filtered replica `userId = 'u1'` bootstrap | 2,510 docs (that user's 2,500 tasks + 10 projects), 38 ms |
| Filtered catch-up after 50 of that user's tasks change | 50 changed, 3 ms |
| Filtered write-back of one title | applied 1, rejected 0, 8 ms; qtask reads it |

What it showed:

- **Speed.** Catch-up is cheap. The engine is not the bottleneck. qtask's sync engine is in the
  same range for the work it does: 10k docs between two devices in 285 ms, and an 8.5 ms no-op
  round at about 4k docs (`docs/perf/lan-engine.md`, `docs/perf/local-sync.md`).
- **The replica sees storage internals, not qtask's model.** It sees the `_c` discriminator, the
  `embedding` vectors, the derived fields, and qtask ids only as padded UUIDs. It writes raw JSON
  with no Mongoose validation and no recomputed `percentComplete`/rollups. It also skips qtask's
  activity log and qtask's role checks. Write-back and full-mode push therefore bypass every
  service-level rule.
- **Conflicts are whole-document.** Under the default `--peer-conflict-policy strict`, edits to
  two different fields of one task conflicted. qtask's engine would have merged them. The replica
  has no resolve helper; the app must rebase or discard the pending commit itself.
- **Writes the replica pushes are invisible to qtask's sync engine.** They reach KDB without going
  through `SyncDataStore`, so they are not tracked or relayed to paired devices until a full
  `reconcile()` (which runs at startup) finds them.

## 3. Feature by feature

| Concern | qtask device sync | `@kdb/replica` 0.1.0 |
|---|---|---|
| **Merge / conflicts** | Per top-level field: version vectors decide what is concurrent, then higher HLC wins. Deterministic and convergent; property-tested with 3 peers, random ops and failed rounds. Losers logged as `sync_conflict` activities. Arrays and sub-documents are atomic. Delete wins. | Full mode: the host merges. The default `strict` policy reports a conflict (observed above even for disjoint fields); `last-write` is the alternative. The local commit stays pending and the app gets a `conflict` event with no resolve helper. Filtered mode: optimistic per document; a refused write is rolled back to the server's state and reported. |
| **Scoping / per-user filtering** | Scopes `u:<user>` and `p:<project>`; the hub serves a caller its own scope plus projects it owns or collaborates on. | Client-supplied KDB-SQL filter per namespace (e.g. `userId = 'u1'`), plus the host's per-document read check. A document leaving the filter or losing access arrives as a delete only when it next changes; immediate revocation needs a reset. |
| **Authorization of writes** | The hub checks each document against qtask's roles: viewer, executor (field allowlist), editor, owner-only deletes and collaborator changes. Paired devices trust each other. | KDB grants `read`/`write`/`sync` per namespace pattern, and per-document read/write/delete resources. The host has no notion of qtask roles or per-field rules, so an executor's token could rewrite any field of a document it may write. |
| **Credentials** | Device token, session JWT to the hub, signed pairing records. | `--rbac` with a durable registry. Since v0.8.0, `kdb-service user role/create/assign --data-dir D` provisions users while the service is stopped. Checked here: no token and a wrong password are refused, the right one works. But tokens are static `user:password`. There is no per-end-user token issuance, so giving each qtask user their own KDB principal would mean a user per account, created offline, or a proxy. |
| **Transports** | LAN (mDNS, mutual TLS), Bluetooth LE (own tunnel via the Swift bridge, simulator-tested only), cloud HTTP; transport selector prefers Wi-Fi. | WebSocket to a Go node (plain HTTP; TLS terminated in front), or a custom `Transport`. **No device-to-device sync, no discovery, no Bluetooth.** Two replicas converge only through a node. |
| **Offline outbox durability** | No separate outbox. Dirty marks plus per-peer cursors in `meta.json`: atomic, fsynced on devices, flushed before each push and pull. The store write and the record commit are not atomic; `reconcile()` repairs this on start (tested with SIGKILL). | Full mode: local commits are durable before `write` resolves, in whatever `KvStore` you give it. Filtered mode: outbox `o/<ns>/<seq>` in the same store, idempotent resend by tx id, survives reopen (tested). Durable only with IndexedDB (strict durability) or a custom store; `MemoryStore` loses it, and Node has no on-disk store. |
| **Catch-up cost** | Cursor per peer; pushes and pulls changed documents in 500-doc batches; optional headers-first to skip documents the peer already has. A new peer receives all headers and documents (no range/Merkle summaries yet). Wire ~1.2 KB/doc raw, ~100-135 B deflated. | Snapshot bootstrap; replay of commits or squash for far-behind replicas (squash refused once a namespace has attachments); zstd pages. Measured above: 5k docs in 158 ms, 500 changes in 57 ms. |
| **Attachments** | Not synced at all (uploads are local-only today). | Yes: lazy verified fetch, bounded blob cache, local puts pinned until uploaded. Works with the new `STORAGE_BACKEND=kdb` layout only if files live in the replicated namespace, and then the replica would see `_c: 'files'` records too. |
| **Platforms** | Node local backend (Mac app runs `kdb-service` and Node as children; WKWebView UI); Swift bridges Bluetooth; cloud hub. React Native mobile does **not** sync (read cache only; offline writes out of scope). | Node ≥ 22 and browsers. No Swift, iOS or React Native support. RN would need IndexedDB, `crypto.getRandomValues`, `btoa` and a WebSocket. The only iOS path in KDB is a full Go node via gomobile. Kotlin `kdb-replica` is JVM-only (no Android target). |
| **Maturity / tests** | 20 `sync-*` test files (~190 `it(` cases, property test 41 runtime cases), 4 `local-sync-*` files (19 cases incl. a two-process e2e with QR pairing and SIGKILL), a two-app macOS UI e2e. Never run on two Macs, real Wi-Fi or a real radio. Known gaps: no tombstone GC, atomic arrays, rejected pushes not reverted, no PAKE. | 0.1.0; 11 test files, 67 cases; interop against a Go host (skipped without a Go toolchain); golden vectors from Go. Browser checked by hand only. Plan doc still says "design"; `src/index.ts` header is stale. |
| **Operations** | No extra listener on devices (KDB's own peer and stream listeners are off). Hub needs `QTASK_SYNC_META_PATH` or it loses tombstones on restart. | Cloud `kdb-service` must expose `--peer-http` (or `--peer-addr`), capped at 64 connections by default. Plain HTTP needs a TLS proxy and `--rbac` users. Clients holding namespaces mean schema and id layout become a public contract. Every node must run v0.8.0+, with no downgrade once attachments exist. |

## 4. What qtask would gain or lose by adopting it

**Gains (real, but narrow):**
- Fast, verified bootstrap and catch-up against a KDB cloud, with live push (`REFS_WATCH`) and no
  qtask code to maintain for that path.
- Attachments, which qtask sync lacks entirely.
- A browser/Node offline client for free if the data model fit. Filtered write-back with a durable
  outbox is the piece qtask's web client does not have today.

**Losses (decisive for the device use case):**
- **Device-to-device sync.** The point of qtask's engine is Wi-Fi and Bluetooth sync between paired
  devices with no server. The replica cannot do it, and neither can anything else in KDB short of
  running a full Go node on each device. The original plan tried that and dropped it
  (`docs/Offline_Desktop_P2P_Plan.md`).
- **Field-level merge** and conflict logging. Both become whole-document conflicts the app must
  resolve.
- **Application rules on writes.** Validation, derived fields, activity history, executor field
  allowlists and owner-only operations would all have to move into KDB policy, which cannot express
  them, or into a proxy.
- **A backend-agnostic engine.** The replica works only if the cloud's source of truth is KDB.
  Production is still MongoDB (migration Stage 0-1).
- **Platform coverage.** Nothing for the Swift app beyond what Node already does, and nothing for
  React Native.
- **License.** AGPL-3.0, like `@limidus/kdb-client`, which is already a dependency. Shipping it in a
  distributed client (the browser bundle) is a bigger licensing step than a server dependency.

## 5. Recommendation

Do not adopt `@kdb/replica` for device sync, and do not plan a migration of the sync engine to it.
The engine solves the problem qtask has (peer-to-peer, field-merged, role-checked sync across a
Mac app, its peers and a Mongo-or-KDB hub). The replica solves a different one: a client mirror of a
KDB node.

Spend the sync effort on the engine's listed gaps instead:
- tombstone GC;
- range/summary reconciliation for new peers (T4);
- reverting rejected pushes;
- real-radio Bluetooth testing.

## 6. When it would make sense, and a staged path for that case

It becomes worth a trial for a **read-mostly web or Node client of the cloud** once all of these
hold:

1. The cloud's source of truth is KDB (migration Stage 4 done).
2. Per-user principals or a token-minting proxy exist. Today `--rbac` users are static and
   provisioned offline.
3. qtask's data is laid out so a filter can scope it. Today projects are shared through
   `collaborators`, so `userId = ?` misses shared projects; a per-user or per-project namespace
   would fix that.
4. `@kdb/replica` has a persistent Node store or the client is browser-only, and it is past 0.x.

Staged path if those come true:

1. **Read-only mirror in the web client.** A filtered, read-only replica per user over a
   WebSocket proxy that maps the qtask session to a KDB principal. It replaces polling and gives
   offline reading. All writes keep going through the qtask API. No change to device sync.
2. **Attachments.** Serve uploads (with `STORAGE_BACKEND=kdb`, in the same namespace or a
   dedicated one) to that client through the replica's blob cache.
3. **Write-back for a whitelisted subset.** Write back only fields whose rules KDB can enforce,
   such as task status for the owner. Rejected writes surface through `conflict` events, which
   the UI must handle. Server-side triggers or a qtask worker would have to recompute derived
   fields and log activity for writes that arrive this way.
4. **Never:** replace the LAN/Bluetooth engine. If KDB ships device-to-device replica sync and a
   Swift/RN client, re-run this evaluation.
