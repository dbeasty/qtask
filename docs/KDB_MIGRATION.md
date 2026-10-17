# Migrating production from MongoDB to KDB

Status: plan, with the tooling, deployment configuration and backup path it depends on built
and rehearsed - on **synthetic** data only. MongoDB remains the default and the only backend any
deployment runs today. Nothing here has met production data or production traffic.

This document says what is proven, what is not, what blocks the migration, and the
stage-by-stage path with the evidence required to advance and the way back at every step.

## 1. Where things stand

The application talks to a `DataStore` / `Collection` contract (`src/data/types.ts`); Mongo
and KDB are two implementations of it. The in-process query engine that KDB relies on is
checked filter-by-filter against a real mongod (`tests/data-query-parity.test.ts`), and one
conformance suite runs against both backends, driving a real `kdb-service` over TCP.

| Piece | State |
|---|---|
| Backend abstraction, Mongo + KDB stores | Done |
| Shadow writes (`DATA_SHADOW_WRITES`), shadow reads (`DATA_SHADOW_READS`) | Done |
| **Pinned to the KDB v0.9.2 release** (from v0.8.0; see "What v0.9.1 changes" and "What v0.9.2 changes") | Done. `@limidus/kdb-client` from the release tarball, `kdb-service` from the same release (`npm run kdb:fetch`, checksum-verified; fetched in CI). Data suite 337/337; whole app on KDB 1,011 of 1,013 tests in the parallel run, the 2 being the supertest load flake (each file passes alone); shadow 1,018/1,018 with **12,306 mirrored writes, 0 failed; 11 divergences in 7,290 reads**; default Mongo suite 1,360/1,360 |
| Filter pushdown to KDB SQL (`DATA_KDB_PUSHDOWN`) | Done, flagged off. Differential test against the in-process engine |
| Server-side expiry replacing Mongo TTL indexes | Done (`_expireAt` + `--expire-field`) |
| Backfill and verify tooling (`npm run migrate:kdb`) | Done. Rehearsed at 552,552 documents (100,000 tasks) of **synthetic** data against an on-disk `kdb-service` (section 8). The rehearsal found and fixed: `appMeta` was never copied; a commit per document capped the backfill at the fsync rate; verify's count of a 100,000-document collection got `kdb-service` OOM-killed (B5) |
| Keyed reads for `_id`, verified deletes; the scan-cap guard | Keyed reads and verified deletes stay; the guard is retired (B1 is fixed since KDB 0.7) |
| Deployment configuration for v0.8.0 | Done and started locally: `docker-compose.kdb.yml` (release image, private network), `deploy/qtask-kdb.service`, `deploy/install-kdb.sh` (checksum-verified install). Section 3 |
| Backups | Done: online backup through the control plane, verified, with retention (`deploy/kdb-backup.sh`, `qtask-kdb-backup.timer`). Restore drill passed on synthetic data (section 8.4); on v0.9.2 a restore is usable in 49 s, with no index rebuild (B6 resolved) |
| **Read cost and memory at scale on disk** | **Narrowed (B5), still blocks Stage 4 for the heaviest accounts.** Re-run on KDB v0.9.2 (section 8.6): every query answers and nothing runs out of memory; a typical user is on par with MongoDB. The heaviest user (8,136 tasks) takes 3.7–9.8 s where MongoDB takes 25–740 ms - KDB issues dbeasty/kdb#325 and #326 - and needs a larger `--memory-budget-mb` than the 1536 the unit sets |
| **KDB 0.7.0 candidate** (`main` at the time of writing) | The whole application passes on it: 133 of 133 test files on KDB, and the default Mongo suite is unchanged |
| The application's own test suite on KDB (`npm run test:kdb`) | Done. A preload gives each test process a private `kdb-service`; the unchanged tests run against the real routes and services |
| Shadow mode as a test run (`npm run test:shadow`) | Done. Mongo primary, KDB mirroring every write and comparing every read: **12,275 mirrored writes, 0 failed, 0 dropped; 23 divergences in 7,266 reads (0.3%)**, down from 729. What is left is races with un-awaited writes (a `lastActiveAt` touch, queue claims), tie ordering, and sub-document ids |
| Durability across `kill -9` on a real on-disk service | Done (`data-kdb-durability`): concurrent acknowledged writes, updates and deletes survive; the unique constraint holds on recovered data; expiry continues |
| Atomicity across processes | Done (`data-kdb-multiprocess`): four processes lose no increment and exactly one wins a claim (server-side `replaceIf`); five processes registering one email let exactly one in (server-held unique constraint, KDB #147) |
| **Anything touching a production dataset** | **Not done. Every number in this document comes from generated data shaped like qtask's (`scripts/rehearsal/dataset.ts`), not from production** |

### What upgrading to v0.6.2 changed (history)

- It builds to a reproducible release artifact. The binary the tests had been using was an
  unversioned dev build; production must install the release binary, never a host build.
- **`kdb-service` now binds peer sync on `127.0.0.1:9091` and a stream listener on `:9092` by
  default.** qtask uses neither. Two instances on one host (staging, a restore drill, parallel
  tests) collide and the second exits. Every harness and the systemd unit pass
  `--peer-addr "" --stream-addr ""`.
- New and used here: document expiry (`--expire-field`), predicates over document paths
  (the basis for pushdown), keyed `get`.
- New and *not* used yet: scored full-text search (`MATCH`, BM25 with stemming), vector search
  (`SIMILARITY`), rank fusion, compound unique constraints enforced at commit, hash/btree
  indexes, mutating SQL, backups and scrub, multi-namespace hosting in the embed API.
  See section 7.

### What v0.8.0 changes for deployment

- Peer sync and the stream listener are off unless asked for (`--peer-addr` / `--stream-addr`
  default to empty); the unit and compose file still pass `""` explicitly. The new 64-connection
  cap on peer-sync listeners therefore does not apply to qtask.
- Storage defaults: the commit graph file, the paged live tree and bounded live bodies are on.
  qtask's namespace starts on v0.8.0, so nothing is converted; the opt-outs are listed in the unit.
- An unpaged SQL reply over 15 MiB is refused; the store already pages its scans.
- Backups and restores are part of the release: `kdb-inspect backup|restore|backup-verify`, and an
  online backup through the control plane (`--control-addr --control-write --control-backup-dir`).
- The image `ghcr.io/dbeasty/kdb/kdb-service:v0.8.0` is published for **linux/amd64 only**; it
  runs on arm64 only under emulation. The release binaries cover linux/darwin arm64 and amd64.

### What v0.9.1 changes

- **The client is renamed `@limidus/kdb-client`**, and before 1.0 a client only accepts a server of
  its own minor version: the tarball, `kdb-service` and the image move together (one pin, in
  package.json). v0.9.1 is v0.9.0's server code republished with all of its release assets.
- **`--control-open`** is required for a control plane on a non-loopback address without `--rbac`.
  qtask's is on loopback in the unit and on the private network in compose, so nothing changes.
- **Reads, counts and expiry no longer read every body**, and the image is published for arm64 too.
  Measured with `npm run bench:docker` (prod scale, KDB only, 2 CPUs / 4 GB), the mixed workload went
  from 0.07 / 0.7 / 0.8 actions/s at 1 / 8 / 32 users on v0.8.0, with timeouts and memory refusals,
  to 0.5 / 2.1 / 2.4 with no errors; with the store changes below, 6.2 / 25.4 / 20.3.
- **Atomic queue claim** (`UPDATE … ORDER BY … LIMIT 1 RETURNING`): the store claims embedding and
  vision jobs in one statement (`DATA_KDB_ATOMIC_CLAIM`, default on, needs pushdown), 10–17 ms where
  the read-then-write claim took 125–230 ms at 15k pending jobs, and no claim loses a race: the
  benchmark's 32-worker claim profile went from 11 to 76 claims/s.
- **A restart was an outage of about 77 s** at 517k documents on 2 CPUs: opening rebuilt the
  unique-key registry by parsing every document whole, once per constraint. Fixed in v0.9.2.
- Rolling back to v0.8.2 is safe for data (the on-disk format is unchanged), but needs the client
  back on `@kdb/client` 0.8.x and the atomic claim off (`DATA_KDB_ATOMIC_CLAIM=false`).

### What v0.9.2 changes

Three server fixes for issues qtask found on v0.9.1. There are no format or protocol changes;
clients 0.9.0–0.9.2 all work with a v0.9.2 server.

- **Opening is about 7x faster (dbeasty/kdb#316):** 11 s instead of 77 s at the benchmark's 517k
  documents. The compose health check's start period went from 5 to 2 minutes.
- **`COALESCE` and `CASE` (dbeasty/kdb#317).** The atomic claim's `$inc` is now
  `COALESCE(x, 0) + n`, exact for a missing or null counter. Before, it required the field and fell
  back to read-then-write when that found nothing.
- **A bad BTREE walk gives up sooner, and `EXPLAIN` works (dbeasty/kdb#318).** Re-measured with it
  (`ORDER_INDEXES` in the store):
  - `createdAt` still pays: the embedding claim takes 4.7 ms instead of 33 ms.
  - `updatedAt` stays undeclared. It still costs about 2x in the normal case, where a just-queued
    job sorts last, and would be rewritten on nearly every write.
- **Benchmark** (prod scale, KDB only, 2 CPUs / 4 GB, no errors in any run). Actions/s at
  1 / 8 / 32 users:
  - mixed: 29.1 / 64.2 / 48.6
  - read-heavy: 28.9 / 60.6 / 39.4
  - write-heavy: 35.7 / 91.2 / 96.7
  - claims: 108 / 300 / 319 per second
  - first answer after a restart: 21 s, including the harness's connect retries
- **Rolling back to v0.9.1** is safe for data, but needs `DATA_KDB_ATOMIC_CLAIM=false`: v0.9.1 can't
  parse `COALESCE`.

## 2. Blockers

### B1. Scans silently stopped at 10,000 documents - resolved; the guard is retired

`kdb-service` v0.6.2 collected the first 10,000 document ids of a non-indexed scan and only then
applied `WHERE`, so on a larger namespace `COUNT(*)` said 10000, filtered reads returned a prefix
of the answer with no error, and lookups and deletes past the cap quietly did nothing. qtask
guarded against it: the store counted the namespace and refused to scan once it reached the cap
(`KdbScanCapError`, `KDB_SERVER_ROW_CAP`), and served `_id` operations through keyed reads.

KDB 0.7 fixed it at the source: `WHERE` runs during the scan, and a reply too large to send is
refused with `RESOURCE_EXHAUSTED` instead of being cut short (since 0.8.0 the bound is 15 MiB).
The store reads scans a page at a time, so it does not hit that bound either. qtask is pinned to
v0.8.0, where the guard could never fire, so it is gone along with its setting; the keyed reads
stay because they are simply faster. `tests/data-kdb-large-namespace.test.ts` keeps the server
honest past 10,000 documents: selective queries and deletes, collection isolation, and a paged
read of a collection larger than one reply.

The limit that does grow with the namespace now is `--scan-row-budget` (rows one scan may examine,
default 1,000,000): see B5.

### B2. No indexes, so reads are linear

Measured with 9,000 tasks, in-memory mode, one process:

| Operation | No pushdown | Pushdown |
|---|---|---|
| `find({ userId })`, 100 rows | 86 ms | 19 ms |
| `findById` | 0.1 ms | 0.1 ms |
| Full collection | 76 ms | 90 ms |
| Backfill rate | about 21,000 docs/s | |

Pushdown helps by moving filtering to the server but the server still scans, so cost grows with
namespace size. **Update:** on the 0.7.0 candidate a hash index on a schemaless namespace works
(`CREATE INDEX … USING HASH`: 10.8 ms to 5.5 ms for the same query), and `COUNT(*)` is
sub-millisecond.

**Indexes now created (`DATA_KDB_DECLARE_INDEXES`, default on).** On connect the store declares the
lookup indexes the Mongoose schemas declare: 27 paths (HASH, or BTREE for dates/numbers; a compound
Mongo index becomes an index on its leading field, plus a `createdAt` BTREE that KDB 0.9 walks for
the embedding queue's `ORDER BY createdAt LIMIT 1` (`ORDER_INDEXES` in the store: a walk only helps
when matches come early in namespace-wide order, so each is measured); text indexes stay in-app, TTL indexes became
server expiry, unique ones are constraints). Declaring is idempotent and they survive `kill -9`
(`data-kdb-durability`). Reads: `find({userId})` on 2,000 tasks 6.2 ms to 0.4 ms.

**Disk write cost: fixed in v0.8.0.** On v0.7.1 every 64th commit rewrote every index snapshot
under the write gate, and each `CREATE INDEX` rewrote all of them twice: bulk load halved (226 to
102 docs/s at 2,000 docs) and a first `connect()` on an empty namespace took about 17 s. v0.8.0
writes snapshots in the background, only for indexes that changed. Measured through the store on
disk with the release binary: bulk load 246 docs/s without indexes, 234 with all 27 (about 5%);
`find({ userId })` 3.9 ms to 0.5 ms with them; a first `connect()` declaring all 27 in 0.5 s.

**On disk at production scale (synthetic data, section 8).** What the in-memory figures above
did not show, all measured against `kdb-service` v0.8.0 on disk with `--durability sync`:

- **Every query carries `_c = ?`, which was not indexed**, so reading or counting a 150-document
  collection cost as much as the whole namespace (1.2–17 s at 27,600 documents, depending on how
  the data had been written). `_c` is now a declared HASH index: 3–7 ms.
- **Unique fields were not indexed** (the constraint lives on a synthetic `_u_…` field), so a login
  by `email`, every MCP request by `keyHash`, every OAuth exchange by `codeHash` examined the whole
  namespace. Their leading fields are now ordinary lookup indexes too: 38 paths in all.
- **`_id: {$in}` reads** were sent as `_c = ? AND kdb_id IN (...)`, which the server answers by
  scanning (2.7 s for 100 ids) rather than by key (6 ms without the `_c` conjunct). They are now
  sent as the id predicate alone, at most 100 ids a statement, the collection checked in process.
- **How a backfill commits decides read speed afterwards.** v0.8.0 keeps a commit as one
  compressed frame, and a cold read of any document in it decompresses the whole frame. A backfill
  in 4 MiB commits left a random keyed read at 14 ms and a collection COUNT at 20 s; in 64 KiB
  commits, 1.2 ms and 1.1 s (27,600 documents). `migrate:kdb` now commits at most 64 KiB.
- **Index order for a first load.** Declaring on the empty namespace and loading through the
  indexes (the store's default) and loading first then declaring cost about the same at 27,600
  documents (84 s vs 35 + 44 s). At 552,552 documents the second order took 630 s + 939 s (section
  8); the first was not run at that size. Either works; the first leaves no window without indexes.

### B3. Unique constraints across processes — resolved in v0.8.0 (KDB #147)

The store's own check (`assertUnique`) is read-then-write, so two *processes* could both pass it.
With KDB #147, `CREATE UNIQUE INDEX` installs a constraint that the server enforces at commit, and
`connect()` declares each collection's constraints. Because every collection shares one namespace
and a server constraint binds every document carrying the field, each one is carried on a
synthetic `_u_<collection>_<fields>` field that only its collection's documents have (a bare
`UNIQUE clientId` would also have bound the authorization codes, which repeat the same clientId by
design; prefixing `_c` does not help). Proven with five real processes racing to register one
email: exactly one wins and the rest get a duplicate key, which `authService` turns into a 409.

The constraint over array elements (a user's linked identity providers: one Google or Microsoft
login may belong to one account) is now held by the server too. The store carries it as an array
of per-element keys, one per linked login, and KDB treats an array under a unique constraint as
multikey, as MongoDB does (KDB v0.8.0). Proven with
five processes racing to link one login to five accounts: exactly one wins. On a server without
multikey support the in-process check still stands, and only the cross-process guarantee for this
one rule is lost.

The store also reads collection scans a page at a time (2,000 documents a page): a single SQL
reply is refused past 10,000 rows on v0.7.1 and past 15 MiB on v0.8.0, so an unfiltered read of a
large collection used to fail with `RESOURCE_EXHAUSTED`. And `KDB_TOKEN` is now actually sent: it
was passed to `connect()` as a bare string, which the client ignores.

A server older than #147 accepts the declarations and enforces nothing; the in-process check
still stands, so it loses the extra guarantee and nothing else. The pinned KDB must include #147,
and multikey for the linked-login rule.

### B4. Search quality differs, deliberately

Lexical search was moved into the application so both backends rank identically; it does no
stemming, so "deploying" no longer matches "deploy" on *either* backend. KDB v0.6.2 can do
stemmed BM25 and vector search server-side. Using it would make rankings backend-specific, which
the conformance suite cannot catch. Decide after the migration, not during it.

### B5. Queries that touch many large documents fail or never answer (blocks Stage 4)

**Status on KDB v0.9.2 (section 8.6): narrowed.** Every query now answers, and nothing runs out of
memory. A typical user's list, count and search are within a few ms of MongoDB. What remains is
the heaviest account (8,136 tasks): 3.7–9.8 s where MongoDB takes 25–740 ms.
- **The KDB planner reads every document of one index.** It ignores the intersection with `_c`
  (dbeasty/kdb#325), and it reads bodies to answer `staging IS MISSING` (dbeasty/kdb#326).
- **The memory budget must leave room above the service's floor.** With 1536 MiB, the heaviest
  user's full list was refused (see `deploy/qtask-kdb.service`).

The original findings follow, as measured on v0.8.0.

Found by the 100,000-task rehearsal (section 8), on the release binary in a Linux container
(4 CPUs, 4 GiB), `--expire-field _expireAt` (qtask needs it). Tasks carry 768-dimension
embeddings, about 16 KiB of JSON each. With `--expire-field` set, every candidate row of a SQL
query has its body read to check its expiry - even for `COUNT(*)` or `SELECT kdb_id` - so a query's
cost follows how many documents it *touches*, not how many it returns.

- **Collection-wide reads exhaust memory, `--memory-budget-mb` notwithstanding.** Listing the ids
  of the 100,000 tasks (`SELECT kdb_id FROM docs WHERE _c = 'tasks'`, paged 500 at a time) took
  `kdb-service` from 726 MiB past the 4 GiB container limit in 27 s and the kernel killed it
  (exit 137, `OOMKilled`), with `--memory-budget-mb 1536`. `migrate:kdb verify` counting the KDB
  copy of `tasks` was killed the same way in all three runs that did it. Heap profile while it
  grew: 717 MiB retained by `engine.readVersionFromFrame`, 1.1 GiB in parsed JSON arrays
  (`json.(*parser).parseArray`).
  Reading the same 100,000 tasks *by key* is fine: 13 s at 761 MiB (500 keyed gets in flight), or
  43 s at 767 MiB in `kdb_id IN (...)` statements of 500 ids. verify now reads by key and no longer
  counts collections above 20,000 documents on KDB (`--count-limit`).
- **The heaviest user's task list is refused.** With the 1,536 MiB budget, `listTasks`, the count
  of their tasks and a lexical search for the user who owns 8,136 tasks all failed with
  `RESOURCE_EXHAUSTED` ("scan needs an estimated 1,789,441,750 bytes, more than the node's entire
  1,560,281,088") or `BUSY` (no grant capacity), where MongoDB answers the first page in 28 ms.
  Admission control did its job - it refused rather than died - but the page cannot be served.
- **A median user's task list did not answer at all.** The same `listTasks` for a user with 17
  tasks (73 visible through shared projects) was still running with `kdb-service` at about 200%
  CPU when the run was stopped some 16 minutes later; MongoDB answers it in 5.6 ms. The query is
  an `$or` over `userId`, `projectIds` and `projectId` plus `staging` absent; on KDB it appears to
  examine the whole 552,552-document namespace, reading every body.
- **Smaller costs.** The unread-notification count was 38 ms (MongoDB 0.7 ms). Idle memory was
  0.7–1.0 GiB at 552,552 documents (index posting lists dominate the heap). A restart after an
  unclean stop took 192–205 s.

What qtask can do: push sort, skip and limit to the server so a page never materialises a whole
list (the store pages the server's result but filters, sorts and limits in process); split the
`$or` into separate indexed queries merged in process; avoid collection-wide counts; store
embeddings outside the JSON document. What needs KDB: expiry checked from an index rather than by
reading bodies, counts from an index, `OR` across indexed fields as an index union, and memory
accounting that covers parsed documents and frame reads. Until enough of that lands to make section
8.3's KDB column acceptable, the cutover must not happen.

### B6. A restore needs its indexes rebuilt, which takes long

**Resolved in KDB v0.9.0, confirmed on v0.9.2 (section 8.4).** A backup now carries its namespace's
schema, constraints and indexes, and `kdb-service` applies them when it first opens the restore.
- A restored service is usable in 49 s, at 20,000 tasks. Before, it took 6.6 s to open and then
  1,296 s re-declaring indexes.
- The store's re-declaration takes 0.0 s, because there's nothing left to do.

The text below is the original finding, as measured on v0.8.0.

A namespace backup (online or `kdb-inspect backup --namespace`) carries the documents but not the
unique constraints and index definitions, which live in KDB's internal `_kdb/meta` namespace. The
qtask store declares them again on connect, so a restored service is correct once the app has
connected - but building 38 indexes and the constraints over the restored data took **1,293–1,296 s
at 110,500 documents** in the drill (section 8.4), against 6.6 s for the service to open the
restored data; the app's first connect blocks for all of it. An offline whole-database backup (`kdb-inspect backup` without `--namespace`,
service stopped) does carry them, but then the first open of the restore rebuilds them instead:
74 s to ready at 27,600 documents, against 2 s for the namespace-only restore of the same data,
after which each missing index or constraint took 1.1–2.4 s to create. Either way the recovery
time grows with the data: plan for it, and measure it on a production-sized restore before
Stage 4.

## 3. Infrastructure

Two ways to run it, both from the v0.8.0 release, never a host build. MongoDB stays as it is in
both until Stage 5.

**systemd (the production layout).** `sudo deploy/install-kdb.sh` downloads `kdb-service` and
`kdb-inspect` for the host's architecture from the release, refuses either unless it matches the
release's `SHA256SUMS` (checked: a tampered mirror is refused, nothing installed), installs them to
`/opt/qtask/bin`, creates `/var/lib/qtask/kdb/data` and `/var/lib/qtask/backups/kdb`, and installs
`qtask-kdb.service`, `qtask-kdb-backup.service` and `qtask-kdb-backup.timer` without starting them.
The unit's flags, each explained in the unit: `--namespace qtask/docs` (= `KDB_NAMESPACE_PREFIX`),
`--durability sync`, `--expire-field _expireAt`, SQL on `127.0.0.1:7700`, admin (`/healthz`,
`/readyz`, `/metrics`) on `127.0.0.1:7701`, the control plane on `127.0.0.1:7702` with
`--control-write --control-backup-dir /var/lib/qtask/backups/kdb` for online backups,
`--memory-budget-mb 1536`, `--scrub-interval 24h`, peer sync and streams off. The same flags (ports,
paths and a shorter expiry interval aside) are what the restore drill runs, so they are known to
start and serve; the unit file itself was not run under systemd here.

**Docker Compose.** `docker-compose.kdb.yml`, added to the existing files:

```bash
docker compose -f docker-compose.yml -f docker-compose.kdb.yml [-f docker-compose.prod.yml] --profile app up -d
```

It adds `kdb` (image `ghcr.io/dbeasty/kdb/kdb-service:v0.8.0`, same flags as the unit, `readyz`
healthcheck, data and backup volumes, 2 GiB memory limit) on an **internal** network that only
`api` and `admin` join, with no published ports; admin and control plane listen on the
container's loopback only. `api`/`admin` get `KDB_ADDR=tcp://kdb:9090` and
`KDB_NAMESPACE_PREFIX`, and pass the stage flags (`DATA_SHADOW_WRITES`, `DATA_SHADOW_READS`,
`DATA_KDB_PUSHDOWN`, `DATA_KDB`) through from `.env`, all off by default, so adding the file alone
changes nothing about which database answers. Validated locally: `docker compose config` for the
default, `+kdb` and `+kdb+prod` combinations (the default's services are unchanged); the stack
started and reported healthy in 7 s; port 9090 unreachable from the host; the app built from this
tree with `DATA_KDB=true` answered `/health` with `"kdb":"ok"`; a smoke run through the app's own
services created a user and five tasks, listed, fetched and counted them, and was refused a
duplicate email; `deploy/kdb-backup.sh` backed it up and verified it in compose mode; torn down
with `down -v`. One defect found and fixed on the way: the image's uid 10001 could not write the
backup mount Docker creates as root, so every backup failed with 503; a one-shot service now hands
the mount over. The image is linux/amd64 only (emulated on an arm64 host).

**Auth and transport.** Without `--rbac`, `kdb-service` checks no credentials. With `--rbac` and
`--data-dir`, v0.8.0 keeps a durable user registry that the same binary provisions while the
service is stopped: `kdb-service user role --data-dir D --role qtask --grants
"read:qtask/*,write:qtask/*"`, then `kdb-service user create --data-dir D --user app --password
... --roles qtask`; the app then connects with `KDB_TOKEN=app:<password>` (checked by hand against
the v0.8.0 binary: no token and a wrong password are refused at the handshake, the right one
reads and writes). Tokens are still static `user:password` pairs, so keep `kdb-service` reachable
only from the application host (loopback or a private network), which is what the plan assumes.

**Backups.** `deploy/kdb-backup.sh` (run daily at 02:45 by `qtask-kdb-backup.timer`, after the
MongoDB backup) asks the control plane for an online backup of the namespace, has the server
re-hash every object against the manifest, fails loudly if that is not clean, then prunes: backups
older than 14 days go, the newest 3 always stay, and content-addressed segment objects no remaining
manifest names are swept (never ones younger than an hour, which may belong to a backup in
progress). With `KDB_COMPOSE` set it does all of that inside the compose container.

What a backup is in v0.8.0: the namespace's delta log - sealed segments whole (shared between
backups), the segment being written as its CRC-verified prefix, and a manifest written last.
Consistency, as the server states it: everything acknowledged before the backup started is in it;
a write that lands during it may or may not be. The drill checked exactly that (section 8).
Restoring is offline and goes to a new directory:

```bash
kdb-inspect restore --namespace qtask/docs --from-backup /var/lib/qtask/backups/kdb \
  --backup-id <id> --out /var/lib/qtask/kdb/data.restored
# then point the unit's --data-dir at it (or swap directories) and start qtask-kdb
```

Constraints and indexes are not in the backup; the app re-declares them on its first connect, and
that takes long on a large namespace (B6). The backups live on the same disk as the data, as the
MongoDB backups do today: shipping them off the host is not part of this work.

**Resource budget.** Measured on the synthetic 552,552-document namespace (section 8): about
0.4 GiB RSS median during the backfill (1.05 GiB peak), 1.0–1.4 GiB while building indexes,
0.7–1.0 GiB idle afterwards, and unbounded under large reads (B5). The unit sets
`--memory-budget-mb 1536` and the compose file a 2 GiB container limit; B5 shows the budget alone
does not keep it inside the limit. Size the host for MongoDB, Node and this together.

### Uploaded files on KDB (`STORAGE_BACKEND=kdb`)

Independent of the data migration, uploads (today: feedback screenshots) can be stored as KDB
attachments instead of on the local disk or S3 (`src/services/storage/kdb.ts`, KDB v0.8.0+).

- **Layout.** One record per file, `{ _c: 'files', key, updatedAt }`, at a document id hashed from
  the storage key, with the bytes as its attachment `content` (media type and size live on the
  attachment). Every operation is a keyed read or write of that one record; nothing scans, and the
  data layer's collection scans (`WHERE _c = ?`) never see these records. A put uploads the bytes
  (1 MiB chunks, hashed and checked against the server's content hash), then commits record and
  attachment together; a file's first put costs one extra commit to create the record. A delete
  removes the record and its attachment in one commit.
- **Config.** `STORAGE_BACKEND=kdb`. It uses the data layer's `KDB_ADDR`, `KDB_NAMESPACE_PREFIX`
  and `KDB_TOKEN` unless `STORAGE_KDB_ADDR`, `STORAGE_KDB_NAMESPACE`, `STORAGE_KDB_TOKEN` are set.
  The namespace must be one the service serves (its `--namespace`): v0.8.0 refuses a session on
  any other. It works with Mongo as the data backend too. `local` stays the default.
- **When to use it.** When KDB already runs beside the app and you want uploads in the same
  backups, durability (`--durability sync`) and integrity checks as the data, without a writable
  upload directory or an S3 bucket. Keep `local` or `s3` for large or many files you need to purge.
- **Integrity.** Reads are verified against the content hash (whole reads before the last page is
  released, ranged reads chunk by chunk with Merkle proofs). Damaged bytes surface as
  `StorageIntegrityError` (`code: 'INTEGRITY'`), never as a missing file; the feedback vision
  queue records it as the job's error and retries, the admin attachment route answers 500.
- **Limits.** Deleting or overwriting a file does not free space: KDB keeps attachment history by
  default (replaced versions become deltas), so the attachment store only grows until history is
  truncated. A namespace that has stored an attachment cannot be opened by KDB builds before
  v0.8.0 (no downgrade). The storage interface is buffer-based, so the app still holds a whole
  upload in memory (as multer does today, 5 MB max); the backend also offers `putStream`,
  `openRead` (whole or ranged, streamed) and `stat` for larger files, whose memory does not grow
  with the file: about 4 MiB of buffers to upload and 15 MiB to download (the client's transport
  buffer; the same for 8, 40 and 64 MiB files), where a buffered `get` of 20 MiB took 22 MiB.
- **Tests.** `tests/storage-kdb.test.ts` (real on-disk service: binary/empty/>1 MiB round trips,
  overwrite, racing puts, delete, missing, 40 MiB streaming and ranged reads, a byte flipped on
  disk surfacing as `StorageIntegrityError`, `kill -9` and restart). The feedback suites run
  against it with `STORAGE_BACKEND=kdb` (`tests/helpers/testObjectStorage.ts`).

## 4. The stages

Each stage names the flag, what to watch, what lets you advance, and the way back. Rollback is
always "unset the flag and restart"; the point of the order is that nothing irreversible happens
before Stage 5.

### Stage 0 — Prove it on production-shaped data (before touching production)

Done on **synthetic** data (section 8): `counts`, `backfill`, `declare`, `verify` at 552,552
documents on disk with `--durability sync`, read latencies of the hot queries on both backends,
and a backup/restore drill. Still to do, with real data:

- `counts` against production (or a restore of it): how large the namespace will be (B5,
  `--scan-row-budget`).
- `backfill`, `declare` and `verify` against a **restored copy** of production Mongo and a scratch
  KDB, as in section 8.2 (the rehearsal script drives its own generated database; the
  `migrate:kdb` steps it runs are the ones to repeat). This is the first time real data meets the
  tool: look for documents that fail to round-trip.
- The restore drill on that copy, for a real recovery time (B6).

Exit: `verify` clean on the restored copy; counts known; restore drill done on it; B5's latencies
and memory acceptable at that size.

### Stage 1 — Abstraction in production (done in code)

Ship the abstraction with Mongo as the primary. No behaviour change. Exit: a release in
production on the new code path with Mongo only, no regressions.

### Stage 2 — Shadow writes

Install and start `qtask-kdb` (`sudo deploy/install-kdb.sh`, then `systemctl enable --now
qtask-kdb qtask-kdb-backup.timer`; or add `docker-compose.kdb.yml`), then:

```
DATA_SHADOW_WRITES=true     # DATA_MONGO / DATA_KDB unset: Mongo stays primary
KDB_ADDR=tcp://127.0.0.1:7700
KDB_NAMESPACE_PREFIX=qtask/docs
```

Every write is mirrored to KDB out of band. Requests never wait on it and never fail because of
it. Watch `data.shadow` on `/health`: `failed` means KDB cannot apply an operation Mongo could;
`dropped` means it cannot keep up and is knowingly stale.

Then, with shadow writes already on, bring KDB level with history:

```bash
npm run migrate:kdb -- counts
npm run migrate:kdb -- backfill     # declares indexes first unless DATA_KDB_DECLARE_INDEXES=false
npm run migrate:kdb -- verify
```

For a large first load, `DATA_KDB_DECLARE_INDEXES=false npm run migrate:kdb -- backfill` followed by
`npm run migrate:kdb -- declare` is also fine (B2); set `KDB_REQUEST_TIMEOUT_MS` high for the
declare, which took 939 s at 552,552 documents. The app declares them again (idempotently) on every
connect either way.

Order matters: shadow writes first, so nothing written during the copy is lost. A write that
lands between the backfill reading a document and writing it can leave KDB one version behind
until the next write; `verify` reports it as `differing`, and re-running `backfill` repairs it.
Repeat until `verify` is clean in a quiet period. Updates to a document that has not been copied
yet will show as shadow `failed`; the backfill supplies the current version, so that is expected
until the first clean verify.

Exit: `failed` and `dropped` flat at zero for 7 days of normal traffic, and `verify` clean.
Rollback: unset `DATA_SHADOW_WRITES`.

### Stage 3 — Shadow reads

```
DATA_SHADOW_READS=true
DATA_KDB_PUSHDOWN=true      # enable together: pushdown is what makes read volume affordable
DATA_SHADOW_READ_SAMPLE=0.2 # only if comparing everything costs too much
```

KDB is asked every question Mongo was and disagreements are reported with the collection,
operation, ids and field *names* (never values). Watch `data.reads`: `diverged` is the number
that gates; `unordered` is not a disagreement but marks a query whose caller silently depends on
Mongo's natural order, to be fixed before the flip.

Add to the exit criteria, because the shadow comparison cannot see them:

- A concurrent-registration test against KDB (B3).
- A full pass of the application's own test suite with `DATA_KDB=true` against a KDB
  populated from a production restore.
- Expiry observed in the real service: an expired OAuth code is gone and a live one is not.

Exit: `diverged` zero for 14 days, long enough to include any periodic jobs; every `unordered`
source understood. Rollback: unset `DATA_SHADOW_READS`.

### Stage 4 — Flip reads (cutover)

Only after B5 is closed (or production's measured latencies and memory are acceptable), the
restore drill has been done on a production-sized copy, and the recovery time it showed (B6) is
acceptable.

The cutover swaps primary and shadow so that Mongo stays current and the way back is a flag, not a
restore:

1. Announce the window; use the existing major-release path (read-only with a banner) if
   writes must pause.
2. Final `backfill` then `verify`; require clean.
3. Set `DATA_KDB=true`, **keep** `DATA_SHADOW_WRITES=true` (now mirroring to Mongo), and
   `DATA_KDB_PUSHDOWN=true`. Restart the app.
4. Smoke test: `deploy/smoke-test.sh`, then log in, create/edit/complete a task, accept an
   invite, run a search and an MCP OAuth flow.
5. Watch `data.shadow` (writes to Mongo) and error rates.

Rollback: unset `DATA_KDB`, restart. Mongo has every write made since the flip because it was the
shadow. This is the property that makes the cutover reversible, and it only holds while shadow
writes stay on.

Exit: 14 days with no rollback trigger. Rollback triggers: `kdb-service` killed or restarted (OOM, exit 75),
`RESOURCE_EXHAUSTED` or `BUSY` refusals reaching users, shadow `failed` growing, `verify` differing,
or p95 latency regression the team will not accept.

### Stage 5 — Retire Mongo

Stop mirroring (`DATA_SHADOW_WRITES` off), keep the Mongo data and its backups for 30 days, then
remove the Mongo container, unit and compose files, `MONGODB_URI`, and the Mongoose runtime
dependency from the data path. This is the first irreversible step; take a final Mongo backup and
a verified KDB backup first.

## 5. What each test covers

| Test file | What it proves |
|---|---|
| `data-query-parity` | The in-process engine agrees with a real mongod |
| `data-store-conformance-{mongo,kdb}` | One suite, both backends, real servers |
| `data-shadow-writes*`, `data-shadow-reads` | Mirroring and comparison behave, including a manufactured divergence |
| `data-kdb-pushdown` | Pushdown never changes an answer (differential), every schema path is a valid column |
| `data-kdb-expiry` | Only collections with a Mongo TTL index expire; invites survive |
| `data-kdb-large-namespace` | Selective queries, deletes, collection isolation and paged scans against a server past 10,000 documents |
| `data-kdb-indexes` | The 38 declared indexes (incl. `_c` and unique fields) exist and never change an answer; keyed `_id: {$in}` lookups in batches |
| `data-kdb-connect` | `KDB_TOKEN` is sent as the client's token option |
| `data-kdb-busy-retry` | A read refused as `BUSY` is retried a bounded number of times, nothing else is |
| `data-migrate-mongo-to-kdb` | Backfill/verify/counts as an operator runs them, including that verify can fail; `appMeta` is copied; an expired TTL document is not "missing"; commit grouping |
| `deploy-kdb-backup` | `kdb-backup.sh prune`: retention window, newest-N kept, only old unreferenced segments swept |

Run with `node --import tsx --test tests/data-*.test.ts`. The KDB suites use the pinned release
(`npm run kdb:fetch`; `KDB_SERVICE_BIN`, `KDB_CLIENT_MODULE` override) and skip with a reason when
it is absent.

Not tests but rehearsals, run by hand (section 8): `scripts/rehearsal/run-migration-rehearsal.sh`
(generate, backfill, declare, verify, sizes, memory, read latencies) and
`scripts/kdb-restore-drill.ts` (backup under writes, restore, checks). `npm run kdb:fetch --
--with-inspect` fetches the release's `kdb-inspect`, which the drill needs.

## 6. Risks that remain

- **No production exposure.** Everything above is a rehearsal, on generated data whose shape is a
  guess (`scripts/rehearsal/dataset.ts` states its assumptions: about 50 tasks per user with a long
  tail, 85% of tasks with embeddings, half a comment and two activity entries per task). Real data
  will have shapes and outliers the generator does not. Stage 0 with a production restore and Stage
  2 exist to turn this into evidence.
- **Read cost and memory at scale (B5)** depend on KDB changes outside this repository and on
  store work not done yet (section 7).
- **Recovery time (B6)** grows with the data; measured only on synthetic data up to 110,000
  documents.
- **The rehearsal host is not the production host.** macOS on Apple silicon, with `kdb-service`
  either native (`F_FULLFSYNC`: about 22 ms per single-document commit) or in a Linux container on
  Docker's VM disk (about 0.9 ms). Production fsync cost will be somewhere else again.
- **Image architecture.** The release image is linux/amd64 only.
- **Single `kdb-service`.** One service is a single point of failure, as one Mongo is today. KDB's
  peer sync could give a replica; that is not part of this plan.
- **Sub-document ids are the same in both stores.** While Mongo is primary and KDB mirrors it,
  the shadow layer gives every sub-document a write introduces its `_id` before either store sees
  the write (`src/data/subdocumentIds.ts`), so both store the same id and a sub-document can be
  addressed by id on either side. Before, each store minted its own, and only the backfill at
  cutover reconciled them. Documents keep their Mongo ids through the backfill as before.
- **Load flakes in the test suite itself** (`socket hang up` from supertest) occur at about the same
  rate on MongoDB and on KDB (1 in 16 runs of `collaboration` under 8-way load on each).
- **KDB comes from a release, never a source tree.** `@limidus/kdb-client` is a dependency at the
  release's version (installed from the release tarball; it is not on npm), and the tests'
  `kdb-service` is the same release's binary, fetched by `npm run kdb:fetch` and checked against
  its `SHA256SUMS`. Production runs that release's image
  (`ghcr.io/dbeasty/kdb/kdb-service:v<version>`). The client refuses a server from another
  release, so the one pin covers both. `KDB_SERVICE_BIN` / `KDB_CLIENT_MODULE` override them, for
  trying a KDB build before it ships.

## 7. Follow-up work

For KDB (each with a reproduction in section 8 or the commit that worked around it):

1. Memory accounting that covers parsed documents and frame reads, so `--memory-budget-mb` holds
   under large reads (B5).
2. `COUNT(*)` from an index without reading bodies, and expiry checked from an index rather than
   by reading each body (B5).
3. `OR` across indexed fields answered as an index union rather than a scan (B5: the task-access
   query of a user with 17 tasks did not answer in 16 minutes). **In review: KDB #298** (Go and
   Kotlin; 20k documents, 26.6 ms to 4.5 ms). Until it ships, the store asks each branch of an
   indexed `$or` separately (`unionBranches`).
4. A keyed `kdb_id IN (...)` lookup that stays keyed when another conjunct precedes it (B2).
5. Cold reads that do not decompress a whole multi-document commit frame (B2), or guidance on
   commit size.
6. Group commit for transaction commits as for `upsert` (a single-document `replace` was one fsync
   each: 22 ms on macOS, whatever the concurrency).
7. Index and constraint definitions in a namespace backup, or a restore that rebuilds them without
   the application (B6); an arm64 image.
8. Tokens beyond static `user:password` pairs (users themselves can be provisioned since v0.8.0:
   `kdb-service user create`, section 3).

For qtask, in rough order of value:

1. Push sort, limit and skip to the server for the hot list queries, so a page of tasks never
   materialises a heavy user's whole list (B5). (Splitting the task-access `$or` into indexed
   queries merged in process is done: `unionBranches`; so are server-side exact counts,
   `exactWhere`.)
2. Store embeddings outside the JSON document (or encoded compactly), which is most of a task's
   size and most of what the server parses (B5).
3. Per-collection namespaces once `kdb-service` hosts several, so a scan never examines other
   collections.
4. Ship backups off the host.
5. Server-side stemmed full-text and vector search, accepting backend-specific rankings (B4).
6. Client replicas (`@kdb/replica`): evaluated against qtask's own device sync in
   `docs/KDB_REPLICA_EVALUATION.md` - not a replacement for it; possibly a read-mostly web client
   once the cloud runs on KDB.

## 8. Rehearsal and drill results (synthetic data)

Everything here ran on generated data (`scripts/rehearsal/dataset.ts`, seed 20261015), never on
production data. Host: macOS 26 on Apple silicon (16 cores), shared with other work while it ran.

### 8.1 The dataset

`scripts/rehearsal/generate-mongo.ts --tasks=100000` into MongoDB 7: 552,552 documents in all
22 collections - 2,000 users, 8,000 projects (30% shared with 1–4 collaborators, 20% nested),
100,000 tasks (steps, subtasks to depth 2, materials and labour lines, tags, links; 85% with a
768-number embedding, so about 16 KiB of JSON each), 50,000 comments, 200,000 activities, 40,000
notifications, 108,000 embedding jobs (one per task and project), 4,000 conversations, 30,000 LLM
call metrics, OAuth clients, codes and tokens, MCP keys and sessions, invites, feedback, two
`appMeta` markers. Per-user volume is Zipf-like: the heaviest user owns 8,136 tasks (8,394
visible with shared projects), the median user 17. Inserted in 74 s; MongoDB reports 1,152 MiB of
data, 881 MiB on disk, 121 MiB of indexes.

### 8.2 The migration path at 100,000 tasks

`scripts/rehearsal/run-migration-rehearsal.sh --tasks 100000` (with `INDEX_ORDER=after`): MongoDB
in a container (2 CPUs), `kdb-service` v0.8.0 (the release's linux-arm64 binary) in a Linux
container with 4 CPUs and 4 GiB, data on a Docker volume, `--durability sync`,
`--expire-field _expireAt`.

| Step | Result |
|---|---|
| `counts` | 552,552 documents, 1.0 s (reads only MongoDB) |
| `backfill` (`DATA_KDB_DECLARE_INDEXES=false`) | 552,446 documents in 629 s: **878 docs/s** overall; tasks 100,000 in 522 s (191/s, about 3 MiB/s of JSON); activities 200,000 in 22 s; embedding jobs 108,000 in 16 s. (106 fewer than counted: auth codes, consents and LLM call metrics MongoDB's TTL monitor removed in between) |
| `declare` (38 indexes + unique constraints over the loaded data) | 939 s |
| `verify` | **44 s, all 22 collections clean** (0 missing, 0 differing). The KDB copy was counted for the 16 collections up to 20,000 documents; the 6 larger ones were not (B5), which verify reports as `extra=unchecked` |
| Disk | KDB 1.0 GiB (delta log 754 MiB, live tree 94 MiB, SSTables 93 MiB, indexes 57 MiB, SSTable index 28 MiB); MongoDB 881 MiB of collections + 121 MiB of indexes |
| `kdb-service` RSS, sampled every 2 s | backfill: median 410 MiB, p95 697, max 1,052; declare: median 1,026, max 1,410; idle after a restart: 712–1,007; verify by key: max 968 |
| Restart of the loaded service | 192–205 s to ready (seven restarts, each after an OOM kill or a forced container removal) |

The first three verify runs got `kdb-service` OOM-killed (the fourth, after the fix, is the row above): verify ended each collection by
counting the KDB copy, and counting (or even listing the ids of) the 100,000 tasks reads every
body. Reproduced directly: `SELECT kdb_id FROM docs WHERE _c = 'tasks'`, paged 500 at a time, took
the service from 726 MiB past 4 GiB in 27 s (`OOMKilled`), with `--memory-budget-mb 1536`. Reading
the same 100,000 tasks by key took 13 s at 761 MiB (500 gets in flight) or 43 s at 767 MiB (`IN`
statements of 500 ids).

### 8.3 Read latency of the hot queries (100,000 tasks)

`scripts/rehearsal/bench-reads.ts`, through the real services (`taskService`, `searchService`,
`notificationService`) and the store, 2 warm-up runs then 20 timed; ms. KDB with
`DATA_KDB_PUSHDOWN=true` and `--memory-budget-mb 1536`.

| Query | MongoDB p50 / p95 | KDB p50 / p95 |
|---|---|---|
| `listTasks`, heaviest user, first page of 50 | 28.3 / 30.6 | **refused**: `RESOURCE_EXHAUSTED`, "scan needs an estimated 1,789,441,750 bytes, more than the node's entire 1,560,281,088" |
| `listTasks`, heaviest user, all 8,394 | 774 / 812 | refused, same |
| `listTasks`, heaviest user, `status=todo`, first page | 28.3 / 31.9 | refused: `BUSY`, "no grant capacity for a scan of an estimated 964,181,430 bytes" |
| `tasks.countDocuments({ userId })`, heaviest user | 2.1 / 2.4 | refused (estimated 1.7 GB) |
| `notificationService.unreadCount`, heaviest user | 0.7 / 1.4 | 38.3 / 44.3 |
| lexical task search "invoice", heaviest user | 65.4 / 69.1 | refused (estimated 1.8 GB) |
| `listTasks`, median user (17 tasks, 73 visible), first page | 5.6 / 9.5 | **no answer**: still running about 16 min later, `kdb-service` at ~200% CPU; run stopped |
| `tasks.findById` | 0.5 / 1.4 | not reached |
| `taskService.getTask` | 1.1 / 2.8 | not reached |
| `tasks.countDocuments({})` | 36.9 / 42.2 | not asked on KDB (B5) |

The remaining KDB rows were not reached. `kdb-service` RSS over the 18-minute KDB bench: median
722 MiB, max 1,368 MiB - within the budget this time: the heavy queries were refused before they
read anything. The MongoDB column is the same dataset in `mongo:7` with 2 CPUs.

### 8.4 Backup and restore drill

**Re-run on KDB v0.9.2** (`--tasks=20000`, same host): **DRILL PASSED.**

| step | result |
|---|---|
| load through the store | 110,512 documents in 61 s (211 s on v0.8.0) |
| online backup under writes | 112 MiB, 7,382 commits, 1.0 s; verified clean |
| `kdb-inspect restore` | 4.5 s; the namespace's definitions (schema, constraints, indexes) restored with it |
| restore usable | first open 49 s (it applies the definitions); the store's re-declaration then takes **0.0 s**, against 1,296 s on v0.8.0 |
| checks | all passed: acknowledged writes (514) present and none stale; nothing created after the backup; 110,306 untouched documents identical; counts within bounds; duplicate email refused; all 39 indexes present; expiry |
| `deploy/kdb-backup.sh` + quiesced restore | exit 0 in 1.2 s; quiesced restore identical to the source (22 collection counts, 111,361 documents) |

The v0.8.0 run follows.

`scripts/kdb-restore-drill.ts --tasks=20000`: native `kdb-service` on macOS with the unit's flags
(`--durability sync`, control plane, `--memory-budget-mb 1536`), 110,512 documents loaded
through the store (`importMany`, 64 KiB commits) in 211 s, 152 MiB on disk. Run alone on the host.

| Step | Result |
|---|---|
| Writes during the backup | task creates, task updates and user creates in a loop: 304 acknowledged before the backup started, 174 while it ran, 324 after |
| Online backup (control plane) | 153 MiB, 7,197 commits, 3 segments (one as its verified prefix), **1.7 s**; verified against its manifest in 0.1 s |
| `kdb-inspect restore` into a new directory | 6.5 s, 7,197 commits applied; 183 MiB |
| `kdb-service` on the restore | ready in 6.6 s |
| Constraints and indexes, before the app connects | **absent** (they live in `_kdb/meta`, which a namespace backup does not carry) |
| The store's first connect (re-declares them) | **1,296 s** (an earlier run, alongside the 100,000-task rehearsal: 1,429 s) |
| After that | a duplicate email refused by the server (`UNIQUE_VIOLATION`) and by `users.create`; all 38 lookup indexes present; the heaviest user's 2,263 tasks by index in 3.5 s |
| Writes acknowledged before the backup started | all 304 present, none stale |
| Documents created after the backup finished | none of 216 present |
| Created while it ran | 86 of 116 present (either is allowed) |
| Untouched documents | 110,289 compared with the source, all identical (9.7 s) |
| Counts | tasks 20,144 within the allowed [20,101, 20,159]; users 544 within [501, 559] |
| Expiry | codes expired before the backup: not readable; a refresh token valid for weeks: there; codes that expired after the restore: gone, and physically swept (10/10) |
| `deploy/kdb-backup.sh backup` with writes stopped | backup (1.5 s, 161 MB), verify (clean), prune: exit 0 |
| Restore of that quiesced backup | 6.1 s; ready in 6.2 s; constraints and indexes re-declared in 1,293 s |
| Quiesced restore against the source | **every collection's count equal (22 collections), every document identical (111,021 compared, 25.8 s)** |
| Sizes | source data dir 218 MiB, backup directory with two backups 179 MiB (segments are shared), restores 195–199 MiB |

One thing the 20,000-task run did not show: that a code still valid at restore time stays
readable until it expires. Its 45-second window had passed during the 1,296 s re-declaration; the
1,000-task run of the same drill showed it (10/10 readable before expiry, 0/10 after, all swept).

### 8.6 The same rehearsal on KDB v0.9.2

`scripts/rehearsal/run-migration-rehearsal.sh --tasks 100000` with `INDEX_ORDER=after`: the same
generator and seed as 8.1–8.3, on `kdb-service` v0.9.2 with the store from qtask#12 (pushdown,
sorted pages chosen by the server, atomic claims). It ran twice, and the second run repeated the
first within 2%.

**The migration path:**

| step | v0.8.0 | v0.9.2 |
|---|---|---|
| backfill | 629 s | **201–204 s** |
| declare (38 indexes + constraints) | 939 s | **405–407 s** |
| verify | 44 s; three earlier runs OOM-killed | **36–37 s**, all 22 collections clean, no OOM |
| `kdb-service` RSS | up to 1.4 GiB | backfill ≤ 532 MiB; declare ≤ 1.19 GiB; benches ≤ 1.36 GiB |

**Read latency** (ms, p50 of 20). MongoDB's numbers repeated 8.3's.

| query | MongoDB | KDB, budget 1536 | KDB, budget 3072 |
|---|---|---|---|
| `listTasks`, heaviest user, first page of 50 | 28.6 | 5,823–6,004 | 6,437 |
| `listTasks`, heaviest user, all 8,394 | 739 | refused (`BUSY`, a ~510 MB grant) | 5,952 |
| `listTasks`, heaviest user, `status=todo`, first page | 25.0 | refused | 9,815 |
| `tasks.countDocuments({ userId })`, heaviest user | 2.1 | 3.0–3.4 | 2.6 |
| `unreadCount`, heaviest user | 0.8 | 1.7–2.2 | 1.7 |
| lexical search "invoice", heaviest user | 64.8 | refused | 3,710 |
| `listTasks`, median user, first page of 50 | 5.6 | 16 when not starved (below) | **11.0** |
| `listTasks`, median user, all 73 | 7.2 | 21 when not starved | **15.6** |
| `listTasks`, median user, `status=todo`, first page | 3.5 | 13 when not starved | **6.4** |
| lexical search, median user | 10.2 | 19.0–19.3 | 17.8 |
| `tasks.findById` / `taskService.getTask` | 0.4 / 1.1 | 0.6 / 0.9–1.0 | 0.5 / 0.9 |

**What the numbers mean:**

- **Budget 1536 (the unit's setting).** The service's own floor (indexes and caches) was
  0.7 GiB after a restart and 1.19 GiB after loading and querying. That left only a few hundred MB
  for query grants.
  - The heaviest user's full list was refused.
  - In the 20-iteration run, the floor rose until even the median user's small reads were refused
    as `BUSY`. Run alone, or with one iteration, they answer in 13–21 ms.
  - Refused grants are released: outstanding grants went back to 0 between queries, so this is not
    a leak.
- **Budget 3072.** Every query answered, there were 0 capacity denials, and RSS stayed at 756 MiB.
- **Heaviest user.** `EXPLAIN` shows where the time goes. For
  `_c = 'tasks' AND userId = ? AND staging IS MISSING`, KDB serves the query from the `userId`
  index and reads all 33,818 of that user's documents, across every collection: 1.4 s for a count
  that takes 3 ms without the `staging` condition. Each branch of the access `$or` pays this, and
  so do the page's sort and its total.
  - Fixing it needs KDB to intersect the index id sets first (dbeasty/kdb#325) and to answer
    `IS MISSING` from an index (dbeasty/kdb#326).
- **Whole-collection counts.** `verify` still skips counting collections above 20,000 documents,
  and `bench-reads` still skips `tasks.countDocuments({})`. Both are v0.8.0 guards (`--count-limit`)
  that v0.9's index-answered counts should make unnecessary; that is a follow-up.

### 8.5 Smaller measurements behind B2 and B5

Native macOS, release binary, 27,600 documents (5,000 tasks) unless stated.

| Backfill commit size | Backfill rate | Random keyed read | COUNT of tasks | COUNT of a 150-doc collection |
|---|---|---|---|---|
| 4 MiB (`sync-mode fast`) | 547 docs/s | 14.3 ms | 20.0 s | 17.6 s |
| 256 KiB (`sync-mode fast`) | 558 docs/s | 1.6 ms | 2.3 s | 1.8 s |
| 1 document (`sync-mode fast`) | 154 docs/s | 0.5 ms | 1.3 s | 1.2 s |
| 64 KiB, with the `_c` index (`sync-mode full`, the default) | 330 docs/s | 1.2 ms | 1.1 s | 5 ms |

- A single-document `replace` costs about 22 ms on macOS (`F_FULLFSYNC`) whatever the
  concurrency, and 0.9 ms in the Linux container; 200 documents in one commit about 100 ms on
  macOS. Hence `importMany`.
- `_c = ? AND kdb_id IN (100 ids)`: 2.7 s without a `_c` index, 21 ms with one, 6–12 ms with the
  id predicate alone.
- Declaring all indexes after a 4 MiB-commit backfill failed after 7 minutes, one `CREATE INDEX`
  (`callType`) exceeding the client's 30 s deadline; after a 64 KiB-commit backfill it took 44 s.
- An offline whole-database backup restored with its indexes; the restored service took 74 s to
  open, against 2 s for a namespace-only restore (B6).
