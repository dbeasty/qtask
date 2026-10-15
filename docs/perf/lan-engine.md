# Sync engine over the LAN transport (Phase 2 on Phase 3)

Command: `npm run perf:lan-engine` (`N`, `BYTES` env vars change the size). Script: `scripts/perf-lan-engine.ts`.
Three separate Node processes (A, B, C), each with its own identity and an in-memory store behind
`SyncDataStore` and the real `SyncEngine`; real pairing, pinned TLS and mDNS on loopback.
Apple M3 Max, Node 26, one run. **Loopback only**: no radio, loss, multicast filtering or roaming.
The 200-byte filler is a repeated character, so wire sizes are far smaller than real task text would give.

| Measure | Result |
|---|---|
| Single change A to B (includes two IPC round trips and polling, so an upper bound) | p50 11.8 ms, p95 13.1 ms (100 samples) |
| Initial sync, 10k docs A to B | 285 ms (about 35k docs/s), 0.24 MB received by B |
| Third device C joins (paired with A and B), 10k docs | 332 ms, 0.97 MB received, 9 rounds, 0 errors |
| No-op round, 3 devices | 1.1 ms |
| 100 edits on A visible on B and C | 26 ms |
| CPU / RSS after the whole run | about 0.9 to 1.1 s CPU, 158 to 281 MB RSS per process |

Observations:
- **Redundant transfer, found and fixed.** The first run above (before the fix) had the joining device C receive
  about 4x what B did for the same data: C pulled from both A and B, and A and B each also pushed to C, so every
  document arrived up to four times. Fixed with a headers-first exchange (`syncWith(transport, { headersFirst })`,
  on by default in `LanSyncCoordinator`): peers swap `{coll, id, version vector}` first and only the documents
  the receiver lacks are sent, in both directions.
  - Counted in `tests/sync-headers-first.test.ts` (3 in-process peers, 300 docs, C joins): documents delivered
    to C fell from 900 to 300 (once each) and JSON bytes from 778,550 to 213,960 (-73%).
  - Three-process run, bytes received by C for 10k docs: 0.97 MB before, 0.51 MB after. Not the full 4x: the
    200-byte filler compresses to almost nothing, so the headers are a large share of what is left. With real
    task text the saving should be closer to the document-count ratio, but I have not measured that.
  - Cost: one extra round trip per batch in each direction. 2-device initial sync of 10k docs went from 238 to
    279 ms on loopback (single runs, so treat the difference as noise-to-small). On a slower link the saved bytes
    should outweigh that, but this is untested on real Wi-Fi.
  - Peers that do not understand headers/offers still work: the sender falls back to the old behaviour.
  - Left alone: the cloud hub path (HTTP) does not use it; devices there talk to one hub, so there is no fan-in.
- The "third device catch-up ms" in the table is not meaningful: pairing finished (and the data had already
  arrived) before the timer started. Use the bytes.
- Real Wi-Fi throughput will be far below loopback.

## After T1 to T3 (2026-10-12)

Two runs of `npm run perf:lan-engine` (10k docs, loopback, M3 Max) with in-flight coordination, progress sharing and single initiator on by default:

| Measure | Before (headers-first only) | Now |
|---|---|---|
| Bytes received by the joining third device | 0.51 MB | 0.30, 0.39 MB |
| Its rounds | 14 | 2 |
| 2-device initial sync, 10k docs | 279 ms | 290, 278 ms |
| 100 edits visible on both other devices | 17 ms | 24, 26 ms |

The no-op round measured 2.1 ms in one run and 29.9 ms in the other. These are single samples with other work on the machine, so treat that one as noise until repeated. See `docs/sync-duplicate-transfer-tasks.md`.
