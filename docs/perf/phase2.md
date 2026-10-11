# Phase 2 sync performance (measured)

Run: 2026-10-11T21:38:17.150Z
Machine: Apple M3 Max, 16 cores, 48 GB RAM; Node v26.0.0; darwin/arm64
Sizes: 1000, 10000, 50000 tasks; no-op runs per size: 50; HTTP section: 1000, 10000, 50000

## Method

- Reproduce: `npm run perf:sync -- --http --http-sizes=1000,10000,50000 --out=docs/perf/phase2.md` (script: `tests/perf/syncPerf.ts`). Single run, single machine, no repetition across runs except where a column says median/p95 over many syncs.
- Workload: tasks of ~15 fields (title, ~200-char description, status, priority, tags, dates, hours, empty steps/subtasks/links) in one project, one account. Synthetic, not production data.
- "In-memory" runs use `MemoryDataStore` for both the device and the hub with a `LoopbackTransport` that JSON-serialises every request and response (so encoding and parsing cost is included, network latency is not). This isolates the sync engine from database speed. Batch size is 500 documents.
- "Real hub" runs use the actual Express app with `QTASK_SYNC_HUB=true` on Mongo (mongodb-memory-server, in the same process) and a real HTTP client over localhost: JWT auth, body parsing, `HubAuthorizer` checks, Mongoose validation and the embedding-job enqueue for every received document. Localhost HTTP has no network latency or bandwidth limit; add round trips x RTT for a real link (an initial push is `ceil(n/500) + 2` requests, a no-op sync is 2).
- Baseline stamp = `engine.init()` over existing local data that was never tracked (the Phase 1 adoption case). Initial push = first `syncWith` to an empty hub, including the hub applying, recomputing derived fields and queueing embeddings. Initial pull = a second, empty device of the same account syncing from the hub.
- Incremental = 100 `updateOne` edits (two fields each) made through the tracked store, then one `syncWith`; then 100 hub-side edits pulled by the device. No-op = repeated `syncWith` with nothing changed.
- Merge = the same field of the same documents edited on both sides while apart; the timed sync captures them, detects the conflicts, writes one `sync_conflict` activity per conflict on the hub, and returns the merged documents to the device. The run asserts the conflict count.
- Heap figures are `process.memoryUsage().heapUsed` deltas after two forced GCs (`--expose-gc`); RSS is the whole process.

### Initial sync, in-memory device and hub, JSON round-tripped loopback (no network)

| tasks | baseline stamp (existing data) | initial push to empty hub | push rate | initial pull by 2nd device | pull rate | push bytes | requests |
|---|---|---|---|---|---|---|---|
| 1,000 | 14 ms | 60 ms | 16,682/s | 27 ms | 37,102/s | 1.4 MB | 5 |
| 10,000 | 101 ms | 489 ms | 20,437/s | 225 ms | 44,448/s | 13.6 MB | 23 |
| 50,000 | 445 ms | 2,159 ms | 23,160/s | 1,105 ms | 45,233/s | 68.2 MB | 103 |

### Incremental sync after the initial sync

| tasks | 100 edits: push | requests | bytes | 100 hub edits: pull | update by _id, raw store | update by _id, tracked store |
|---|---|---|---|---|---|---|
| 1,000 | 8.70 ms | 3 | 137.3 KB | 5.30 ms | 10.5 us | 10.1 us |
| 10,000 | 23 ms | 3 | 137.6 KB | 6.48 ms | 9.6 us | 10.0 us |
| 50,000 | 112 ms | 3 | 138.1 KB | 3.70 ms | 9.5 us | 9.7 us |

### Repeated no-op sync (nothing changed on either side)

| tasks | median | p95 | requests per sync | bytes per sync |
|---|---|---|---|---|
| 1,000 | 0.01 ms | 0.03 ms | 2.0 | 265 B |
| 10,000 | 0.01 ms | 0.01 ms | 2.0 | 267 B |
| 50,000 | 0.01 ms | 0.01 ms | 2.0 | 267 B |

### Merge throughput (same field edited on both sides, then synced)

| tasks in store | conflicting docs | sync time (merge + activity log + apply) | docs/s |
|---|---|---|---|
| 1,000 | 1,000 | 95 ms | 10,496 |
| 10,000 | 5,000 | 440 ms | 11,371 |
| 50,000 | 5,000 | 510 ms | 9,808 |

Pure `mergeRecords` (15-field document, no I/O): 1,282,376 merges/s with no conflict, 270,778 merges/s when every field conflicts.

### Memory and storage (heap after forced GC)

| tasks | document data | sync records (device) | sync records (hub, after receiving) | records per doc | snapshot JSON | snapshot time |
|---|---|---|---|---|---|---|
| 1,000 | 2.3 MB | 0.9 MB | 3.7 MB (incl. its copy of the documents) | 924 B | 1.8 MB | 4.07 ms |
| 10,000 | 22.4 MB | 6.7 MB | 32.0 MB (incl. its copy of the documents) | 702 B | 15.6 MB | 31 ms |
| 50,000 | 112.6 MB | 32.9 MB | 134.3 MB (incl. its copy of the documents) | 690 B | 66.6 MB | 139 ms |

Process RSS at the end of the in-memory runs: 1,396.3 MB.

### Device (in-memory) to the real hub: Express + Mongo (mongodb-memory-server) over HTTP on localhost

| tasks | initial push | push rate | initial pull (2nd device) | pull rate | incremental (100 edits) | no-op median | no-op p95 |
|---|---|---|---|---|---|---|---|
| 1,000 | 705 ms | 1,418/s | 34 ms | 29,058/s | 54 ms | 1.08 ms | 2.06 ms |
| 10,000 | 5,273 ms | 1,896/s | 330 ms | 30,321/s | 122 ms | 1.43 ms | 2.15 ms |
| 50,000 | 23,515 ms | 2,126/s | 1,671 ms | 29,931/s | 489 ms | 1.15 ms | 1.77 ms |

## Reading these numbers

What the data supports:

- **Initial sync scales linearly with document count** once derived-field recomputation is deferred to the last batch of a push (`PushRequest.more`). An earlier run of the same harness, before that change, took 8.8 s for the 50,000-task in-memory push against 0.69 s for 10,000 (a single run, kept here as the reason the flag exists): the hub was rebuilding the project rollup, which reads every task in the project, once per 500-document batch.
- **Incremental sync cost follows the number of changes, not the store size** for the push side: 100 edits are 3 requests and about 137 KB at every size; the in-memory time grows from 8.7 ms to 112 ms between 1,000 and 50,000 tasks, so something is still proportional to store size there (not investigated; the likely candidates are the per-sync scan in `meta.countSince` and the capture pass, both in-memory loops).
- **A repeated no-op sync is two small requests (about 265 bytes)**; in memory it is 0.01 ms regardless of size, over real HTTP about 1.1 to 1.4 ms median on localhost. On a real link it costs two round trips.
- **The real hub is bounded by the database, not the engine**: 1,400 to 2,100 documents per second into Mongo (Mongoose create, validation, the two upserts of the embedding-job queue per document) against 16,000 to 23,000 per second into the in-memory store. Pulling is fast (about 30,000 documents per second) because the hub only reads. A first sync of 50,000 tasks to the cloud took 23.5 s on localhost.
- **Merge is not the bottleneck**: about 10,000 conflicting documents per second end to end (including the activity-log writes), and 270,000 to 1.28 million `mergeRecords` calls per second without I/O.
- **Memory**: the sync records cost roughly 690 to 700 bytes per document in V8 heap at 10,000 and 50,000 documents (924 B at 1,000, where fixed overhead shows), against about 2.2 KB per document for the tasks themselves in the in-memory store; a persisted snapshot is about 1.3 KB per document of JSON (66.6 MB for 50,000), written in 139 ms.

What it does not cover:

- No real network: localhost HTTP only; Wi-Fi/Bluetooth transports are Phase 3.
- The hub's database was MongoDB in memory in the same process, not a deployed Mongo or KDB.
- Tracking-layer write overhead was measured only for updates whose filter is `{ _id }`, where no lookup is needed (about 10 us either way). A write by any other filter pays one extra `find` of ids first; that cost was not measured.
- One run on one machine; run-to-run variance was not measured. Sizes above 50,000, many users on one hub, and long-offline tombstone growth were not measured.
- Mobile-class hardware was not measured.
