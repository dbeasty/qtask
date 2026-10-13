# Remaining duplicate transfer in device sync: tasks

Status: T6, T1, T2 and T3 implemented 2026-10-12 (see "Results" at the end). T4 and T5 open. Applies to `src/sync/engine.ts` and the coordinator in `src/sync/lan/rpc.ts`, on `integration/offline-p2p`.

## What is already fixed

- **Headers-first** (`f594df3`): peers swap `{coll, id, version vector}` before content, so a document the receiver already holds is not sent. A joiner between two neighbours went from 900 to 300 deliveries for 300 documents (`tests/sync-headers-first.test.ts`).
- **Single initiator** (`shouldInitiate`, Phase 4): only the lower node id starts a round on a link. Measured in `docs/perf/phase4.md`, it halves an ordinary two-device sync over Bluetooth. It is on in the Bluetooth tests and is being turned on for local mode by the wiring work. It is not yet the default.

## What is still duplicated (measured)

In-process engines, 1,000 tasks, a new device J joining neighbours that already hold everything, headers-first on. The neighbours hold the same data.

| Neighbours | J's rounds | Documents sent to J | Headers exchanged in J's rounds | Headers exchanged in the neighbours' rounds back to J |
|---|---|---|---|---|
| 2 | concurrent (what the coordinator does today) | 2,000 | 3,000 | 3,000 (0 documents) |
| 2 | one after another | **1,000** | 3,000 | 3,000 (0 documents) |
| 3 | concurrent | 3,000 | 5,000 | 5,000 (0 documents) |
| 3 | one after another | **1,000** | 5,000 | 5,000 (0 documents) |

Read from the table:

1. **Concurrent rounds duplicate content k times.** J asks every neighbour at once, so every neighbour's headers arrive before any documents are applied, and headers-first says "needed" to all of them. Run one after another, each document arrives once.
2. **Headers are exchanged for the whole data set on every new link,** in both directions, including J offering back to B what it just got from A. For 1,000 tasks that is 3,000 to 5,000 headers where 1,000 documents moved.
3. **The neighbours' own rounds toward J move no documents but repeat every header.** J's pull from A advanced J's cursor at A, but A's separate push cursor toward J is still 0, so A's next round re-offers everything.

Single initiator removes the third row's work on a single link when the other end is the one that pulled, but not on a mesh where both sides have rounds with other peers.

## Tasks

Ordered by value for effort. Each is its own PR, with a test that asserts the bound, not just convergence.

### T1. Never pull the same document from two peers at once — small

- Keep an engine-wide set of `coll:id` currently requested (between the headers response and the content apply). In `pullFrom`, drop headers already in flight from another peer; after that round applies, re-check what is still needed instead of trusting the first answer.
- Push side, same rule: do not ask peer B for content that peer A is mid-way through sending.
- Simpler alternative if the set is awkward: serialise *pull* phases across peers in the coordinator (one pull at a time per engine), keeping push phases parallel. Costs latency on a mesh, so prefer the in-flight set.
- **Done when:** the table's "concurrent" rows deliver exactly N documents for 2 and 3 neighbours, in the in-process test and in the three-process LAN e2e. A neighbour that drops mid-transfer must not leave documents missing: the next round re-requests them, tested with a link killed mid-batch.

### T2. Share progress across the two directions of a link — small

- When J pulls from A up to sequence S, A learns that J holds everything A had up to S. Record it on A as A's push cursor toward J (`servePull` sets `pushedSeq` for `from` to `max(pushedSeq, next)` when the cursor and epoch match).
- The mirror case: when A pushes to J, include A's sequence range, so J can advance its pull cursor at A.
- **Done when:** after J's round with A, A's round toward J sends 0 headers and 0 documents. The third column of the table drops to about zero.

### T3. Make single initiator the default everywhere — small

- `shouldInitiate` defaults to lower-node-id on every transport, with the existing passive fallback. A local write still triggers a round from either side, so latency is unaffected.
- **Done when:** a two-device LAN sync moves each document and header once, measured in `scripts/perf-lan-engine.ts`.

### T4. Skip the header exchange when two peers already agree — medium

- Before sending headers, exchange a summary per scope: a hash of the sorted `(id, vv)` set, split into ranges (range-based set reconciliation, recursing only into ranges whose hashes differ).
- In-sync peers then cost one small message instead of N headers, and a peer missing a few documents costs about log N messages.
- Removes the header half of problem 2, which dominates the steady state on Bluetooth: every reconnect currently re-sends headers for anything past the cursor.
- **Done when:** a reconnect between two in-sync peers with 10k documents exchanges under 1 KB of sync payload, and a peer missing 10 documents exchanges O(10 + log N) headers. A fuzz test checks agreement with the plain header exchange on random sets.

### T5. Do not offer a document back to the peer it came from — small, partly covered by T2 and T4

- J re-offers to B what it got from A, because the `src` exclusion only skips the exact peer that sent it.
- Track the version vector each peer is known to hold per document. "Known" means received from it, or confirmed by its `need` list. Skip offering any document whose vv the peer already covers.
- Only worth doing if T2 and T4 leave measurable header traffic. Measure first.

### T6. Byte accounting in the engine, so this stays fixed — small, do first or with T1

- `SyncResult` and `engine.status()` report documents and headers sent and received, and duplicates applied as no-ops, per peer.
- Add a perf assertion to `tests/sync-headers-first.test.ts` and the LAN e2e: duplicate no-op applies must be 0 in the join scenarios.
- **Done when:** a regression that re-introduces duplicates fails a test, instead of only showing up in a perf doc.

## Order and size

T6, then T1, T2 and T3 (one or two days together), then T4 (a few days, the only real design work), then T5 only if measurements still justify it.

T1 to T3 fix the cases in the table. T4 is what makes Bluetooth reconnects cheap at 10k-document scale.

## Results (T6, T1, T2, T3)

Implemented in `src/sync/engine.ts` and `src/sync/lan/rpc.ts`, with bounds in `tests/sync-duplicate-transfer.test.ts`. The T1 tests fail when the coordination is disabled.

- **T6:** `SyncResult.traffic` and `engine.status().traffic` report documents and headers sent and received, and duplicates (documents received that applied as a no-op).
- **T1:** an engine-wide in-flight set. A pull round claims what it is about to fetch. A second round wanting the same documents fetches the rest first, then waits for those, then re-judges, and fetches anything still missing (so a failed fetch elsewhere loses nothing; tested).
  - Answering an offer claims the documents until that peer's push arrives. A new round with that peer releases any claim a dead round left.
  - Serve handlers never wait: a link delivers one message at a time, so a handler that waited could block the reply the other round needs. `LinkRpc` now also serves requests without holding up the link. Both were found as a deadlock in the simulated-Bluetooth tests.
- **T2:** `shareProgress`.
  - After pulling, the puller acks how far it got (`PullRequest.ack`); the server records that as its push progress toward the puller.
  - The last push batch carries `through`, so the receiver advances its pull cursor at the sender.
  - Only for unscoped (fully trusted) peers; the hub ignores both.
- **T3:** `PeerLinkTransport.localId`; the coordinator's default is that the lower id starts the round, with the existing passive fallback. Pass `shouldInitiate: () => true` for both ends.

Measured, same setup as the table above, with headers-first and shareProgress on:

| Neighbours | Documents to J, before → after | Duplicates | Headers in the neighbours' rounds back to J, before → after |
|---|---|---|---|
| 2 | 2,000 → 1,000 | 0 | 3,000 → 1,000 |
| 3 | 3,000 → 1,000 | 0 | 5,000 → 2,000 |

Three-process LAN run (`npm run perf:lan-engine`, 10k docs, loopback): bytes received by the joining third device went from 0.51 MB (headers-first only) to 0.30 and 0.39 MB in two runs, and its rounds from 14 to 2. The 2-device initial sync was unchanged (278 to 290 ms).

What is left is headers for documents a device got from one neighbour being offered to another (the "after" column), which T4 (summaries) or T5 (per-peer known version vectors) would remove.
