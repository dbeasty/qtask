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
- C received about 4x what B did for the same data. C pulls from both A and B, and each sends everything because
  neither knows what the other already delivered. This is the redundancy Phase 3 saw with its stand-in, and it
  is still there with the real engine. Applying the duplicates is a no-op, so correctness holds; the cost is
  bandwidth and CPU on a joining device. I did not confirm the exact split between sources.
- Real Wi-Fi throughput will be far below loopback, so the redundancy matters more there.
