# Migrating production from MongoDB to KDB

Status: plan, with the tooling and safety rails it depends on already built and tested.
MongoDB remains the default and the only backend any deployment runs today.

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
| **Pinned to the KDB v0.8.0 release** | Done. `@kdb/client` from the release tarball, `kdb-service` from the same release (`npm run kdb:fetch`, checksum-verified; fetched in CI). Data suite 337/337; whole app on KDB 1,011 of 1,013 tests in the parallel run, the 2 being the supertest load flake (each file passes alone); shadow 1,018/1,018 with **12,306 mirrored writes, 0 failed; 11 divergences in 7,290 reads**; default Mongo suite 1,360/1,360 |
| Filter pushdown to KDB SQL (`DATA_KDB_PUSHDOWN`) | Done, flagged off. Differential test against the in-process engine |
| Server-side expiry replacing Mongo TTL indexes | Done (`_expireAt` + `--expire-field`) |
| Backfill and verify tooling (`npm run migrate:kdb`) | Done, tested on 1,200 documents against a real mongod |
| Keyed reads for `_id`; the scan-cap guard (retired with KDB 0.7, see B1) | Done |
| `kdb-service` systemd unit | Written (`deploy/qtask-kdb.service`); flags verified to start and report healthy |
| **KDB 0.7.0 candidate** (`main` at the time of writing) | The whole application passes on it: 133 of 133 test files on KDB, and the default Mongo suite is unchanged |
| The application's own test suite on KDB (`npm run test:kdb`) | Done. A preload gives each test process a private `kdb-service`; the unchanged tests run against the real routes and services |
| Shadow mode as a test run (`npm run test:shadow`) | Done. Mongo primary, KDB mirroring every write and comparing every read: **12,275 mirrored writes, 0 failed, 0 dropped; 23 divergences in 7,266 reads (0.3%)**, down from 729. What is left is races with un-awaited writes (a `lastActiveAt` touch, queue claims), tie ordering, and sub-document ids |
| Durability across `kill -9` on a real on-disk service | Done (`data-kdb-durability`): concurrent acknowledged writes, updates and deletes survive; the unique constraint holds on recovered data; expiry continues |
| Atomicity across processes | Done (`data-kdb-multiprocess`): four processes lose no increment and exactly one wins a claim (server-side `replaceIf`); five processes registering one email let exactly one in (server-held unique constraint, KDB #147) |
| **Anything touching a production dataset** | **Not done. Nothing here has seen production data or traffic** |

### What upgrading to v0.6.2 changed

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
Mongo index becomes an index on its leading field; text indexes stay in-app, TTL indexes became
server expiry, unique ones are constraints). Declaring is idempotent and they survive `kill -9`
(`data-kdb-durability`). Reads: `find({userId})` on 2,000 tasks 6.2 ms to 0.4 ms.

**Disk write cost: fixed in v0.8.0.** On v0.7.1 every 64th commit rewrote every index snapshot
under the write gate, and each `CREATE INDEX` rewrote all of them twice: bulk load halved (226 to
102 docs/s at 2,000 docs) and a first `connect()` on an empty namespace took about 17 s. v0.8.0
writes snapshots in the background, only for indexes that changed. Measured through the store on
disk with the release binary: bulk load 246 docs/s without indexes, 234 with all 27 (about 5%);
`find({ userId })` 3.9 ms to 0.5 ms with them; a first `connect()` declaring all 27 in 0.5 s.

### B3. Unique constraints across processes — resolved by KDB #147 (not yet released)

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

## 3. Infrastructure

**Installing KDB.** From the v0.6.2 release (`dist/bin/kdb-service-linux-<arch>`, with
`SHA256SUMS`). Verify the checksum, install to `/opt/qtask/bin/kdb-service`. Never build on the
host. The local build used for development reports `commit_dirty=true`; that must never reach
production.

**Running it.** `deploy/qtask-kdb.service`. Loopback only; `--durability sync` (every
acknowledged write is fsynced); data under `/var/lib/qtask/kdb/data`; `--namespace` equal to
`KDB_NAMESPACE_PREFIX` (use `qtask/docs`, the form the tests exercise). Health: `curl
127.0.0.1:7701/healthz` and `/readyz`.

**Auth and transport (gap as of v0.8.0).** A standalone `kdb-service` cannot be given qtask's
credentials: without `--rbac` it checks none, and with it users exist only if created through the
Go API (no flag, file or `CREATE USER`). Until KDB adds that, `kdb-service` must only be reachable
from the application host (loopback or a private network), which is what the plan assumes.

**Auth and transport.** v0.6.2 has TLS and token auth, but the plan assumes loopback and a host
firewall like MongoDB today. If KDB ever leaves loopback, enable TLS and set `KDB_TOKEN` first.
The admin endpoint on 7701 is unauthenticated plain HTTP; keep it on loopback.

**Backups.** The existing backup timer dumps MongoDB. KDB needs its own:
`kdb-inspect backup --data-dir ... --namespace qtask/docs --to <dir>` writes a verifiable,
manifest-defined backup; `kdb-inspect verify` checks a data directory and `restore` rebuilds one.
Wire the backup into `qtask-backup.service` and run a real restore drill before Stage 4. Until a
restore has been done once, there is no KDB backup, only files.

**Resource budget.** `kdb-service` governs memory itself (auto-detects the container or host
limit, 75% of RAM by default). On the shared app server alongside Mongo and Node, set
`--memory-budget-mb` explicitly.

## 4. The stages

Each stage names the flag, what to watch, what lets you advance, and the way back. Rollback is
always "unset the flag and restart"; the point of the order is that nothing irreversible happens
before Stage 5.

### Stage 0 — Prove it on production-shaped data (before touching production)

- `counts` against production (or a restore of it), to size the backfill.
- Run `backfill` and `verify` against a **restored copy** of production Mongo and a scratch KDB.
  This is the first time real data meets the tool: look for documents that fail to round-trip.
- Take disk timings (B2) with `--durability sync`.
- Restore drill for KDB backups (section 3).

Exit: `verify` clean on the restored copy; counts known; restore drill done; disk latency
acceptable.

### Stage 1 — Abstraction in production (done in code)

Ship the abstraction with Mongo as the primary. No behaviour change. Exit: a release in
production on the new code path with Mongo only, no regressions.

### Stage 2 — Shadow writes

Install and start `qtask-kdb`, then:

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
npm run migrate:kdb -- backfill
npm run migrate:kdb -- verify
```

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

Only after B1 is resolved or production is demonstrably far under the cap, and the restore drill
is done.

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

Exit: 14 days with no rollback trigger. Rollback triggers: any `RESOURCE_EXHAUSTED`, shadow
`failed` growing, `verify` differing, or p95 latency regression the team will not accept.

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
| `data-migrate-mongo-to-kdb` | Backfill/verify/counts as an operator runs them, including that verify can fail |

Run with `node --import tsx --test tests/data-*.test.ts`. The KDB suites expect a KDB checkout
beside qtask (`KDB_ROOT`, `KDB_SERVICE_BIN`, `KDB_CLIENT_MODULE` override), and skip with a
reason when it is absent.

## 6. Risks that remain

- **No production exposure.** Everything above is a rehearsal. Stage 0 and 2 exist to turn this
  into evidence.
- **Performance on disk is unmeasured.** The figures in B2 are in-memory.
- **Single `kdb-service`.** One service is a single point of failure, as one Mongo is today. KDB's
  peer sync could give a replica; that is not part of this plan.
- **Sub-document ids are the same in both stores.** While Mongo is primary and KDB mirrors it,
  the shadow layer gives every sub-document a write introduces its `_id` before either store sees
  the write (`src/data/subdocumentIds.ts`), so both store the same id and a sub-document can be
  addressed by id on either side. Before, each store minted its own, and only the backfill at
  cutover reconciled them. Documents keep their Mongo ids through the backfill as before.
- **Load flakes in the test suite itself** (`socket hang up` from supertest) occur at about the same
  rate on MongoDB and on KDB (1 in 16 runs of `collaboration` under 8-way load on each).
- **KDB comes from a release, never a source tree.** `@kdb/client` is a dependency at the
  release's version (installed from the release tarball; it is not on npm), and the tests'
  `kdb-service` is the same release's binary, fetched by `npm run kdb:fetch` and checked against
  its `SHA256SUMS`. Production runs that release's image
  (`ghcr.io/dbeasty/kdb/kdb-service:v<version>`). The client refuses a server from another
  release, so the one pin covers both. `KDB_SERVICE_BIN` / `KDB_CLIENT_MODULE` override them, for
  trying a KDB build before it ships.

## 7. Follow-up work KDB v0.6.2 makes possible

In rough order of value, none of it required for the migration:

1. Merge and release the B1 fix (above); then per-collection namespaces and hash indexes on `userId`,
   `projectIds`, `taskId`, which turn linear reads into lookups.
2. ~~Create the hash indexes the schemas already declare~~ Done; see B2 for the disk write-cost caveat.
3. Server-side stemmed full-text and vector search in place of the in-process scoring and the
   embeddings path, accepting that rankings stop being backend-identical.
4. `kdb-service --scrub-interval` for scheduled integrity checks, and peer sync for a warm replica.
