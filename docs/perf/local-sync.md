# Device sync in local mode: measurements

Measured 2026-10-12 on one Mac (Apple silicon, macOS 26, Node 26.0.0 for the script-driven
backends, the app's bundled Node 22.0.0 for the app runs). Two devices on **one machine**:
the Wi-Fi transport ran over loopback / this Mac's own address, so these numbers contain no
real radio or Wi-Fi latency. Nothing here was measured on two Macs, on real Wi-Fi or over a
real Bluetooth radio.

Reproduce:

```
SAMPLES=40 SEED=2000 IDLE_S=60 npx tsx scripts/perf-local-sync.ts     # backends only (JSON)
E2E=1 scripts/build-macos.sh && QTASK_E2E_IDLE_SECONDS=60 node e2e/macos/sync.mjs   # two app copies
```

## Write on A to visible over REST on B

`scripts/perf-local-sync.ts`: two local-mode backends (separate processes, own kdb-service and
data folder), paired over the Wi-Fi transport. A REST write on one, then the other is polled
over REST every 5 ms until `GET /api/tasks/:id` returns it. 1.5 s of quiet between samples, so
each write starts from an idle device. The time includes the 400 ms write debounce
(`WRITE_DEBOUNCE_MS`), which is a deliberate floor.

| Store size (documents in the sync records) | Direction | n | p50 | p95 | max |
|---|---|---|---|---|---|
| ~160 | A → B (A lower node id) | 40 | 444 ms | 469 ms | 470 ms |
| ~160 | B → A | 40 | 564 ms | 722 ms | 777 ms |
| ~4,160 (2,000 seeded tasks plus their activity entries) | A → B | 20 | 734 ms | 3,533 ms | 3,533 ms |

An earlier run with only 300 ms between samples gave p50 176 ms / p95 217 ms: a round armed by
the previous sample's trailing writes (activity entries, project rollups) fired early. That is
not what an isolated write sees, so the table uses the 1.5 s gap. The B → A direction was
consistently about 120 ms slower than A → B; not investigated. The 4k-document p95 is one
outlier of 20 samples; the p50 rise reflects capture and headers-first rounds over a larger
record set.

Seeding: 2,000 tasks written through REST on A, 50 concurrent at a time, took 123 s (≈61 ms per
task create while sync rounds ran alongside); B had all of them 54 ms after the last write.

## Through the app UI (two app copies)

`e2e/macos/sync.mjs`, one run each: write on A (page fetch through the bridge) until the title is
in B's rendered Tasks view without a reload (long poll on `/api/local-sync/revision` and a view
refresh): **514 ms** (A → B) and **622 ms** (B → A). Earlier runs of the same script: 646/556 ms
and 581/635 ms.

## Cost of a no-op sync cycle

`POST /api/local-sync/now` with nothing to send (one round with the one connected peer:
hello, headers-first push offer, pull; HTTP to the backend included), 40 cycles:

| Documents | p50 | p95 | max |
|---|---|---|---|
| ~160 | 0.9 ms | 1.5 ms | 7.1 ms |
| ~4,160 | 8.5 ms | 11.0 ms | 15.5 ms |

## Idle CPU

Backends only (`scripts/perf-local-sync.ts`): node + kdb-service of each device, `ps` CPU time
over 60 s with nothing happening, as % of one core per device.

| Configuration | CPU |
|---|---|
| Device sync off (`QTASK_LOCAL_SYNC=0`) | 0.03 % |
| Sync on, not paired (listener + mDNS only) | 0.05 % |
| Sync on, paired and connected (keep-alive pings, mDNS) | 0.07 % |

Whole app (`e2e/macos/sync.mjs`, window visible on the Tasks view, app + node + kdb-service, 60 s,
single runs):

| Configuration | total | app process | node | kdb-service |
|---|---|---|---|---|
| Paired and connected, copy A | 1.87 % | 1.75 % | 0.12 % | 0 % |
| Paired and connected, copy B | 1.08 % | 0.95 % | 0.13 % | 0 % |
| Sync off (`QTASK_LOCAL_SYNC=0`), copy A relaunched | 0.95 % | 0.87 % | 0.08 % | 0 % |

The backend's share of idle CPU goes from 0.08 % to 0.12–0.13 % with sync on. The app process
(WebKit, the window) dominates and varies between copies and runs by about as much as the
difference measured, so these single samples do not show a sync effect on the app process
itself; the page's long poll is one request per 25 s when nothing changes.

## Limits

* One machine; loopback. No Wi-Fi latency, loss, roaming or client isolation.
* Bluetooth was not measured here (the bridge test runs on the simulated radio in real time;
  see `docs/perf/phase4.md` for simulated BLE throughput).
* KDB caps scans at about 10,000 documents (`docs/perf/phase1.md`); the largest run here stays
  at ~4,200 sync records.
