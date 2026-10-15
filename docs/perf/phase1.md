# Phase 1 performance: Mac app, single device, offline

Measured by `e2e/macos/perf.mjs` on 2026-10-11. Raw numbers: `docs/perf/phase1.json`.
Nothing here is estimated; a cell reads `n/a` when it was not measured, and a failure is recorded where it happened.

## Machine and build

- Mac15,9, Apple M3 Max, 16 cores, 48 GB RAM, macOS 26.5.2
- App: release build with the E2E control folder compiled in (`E2E=1 scripts/build-macos.sh`); bundle 153.87 MB
- Helpers in the bundle:
```
node:        v22.0.0 (/Users/davidj/.gradle/nodejs/node-v22.0.0-darwin-arm64/bin/node)
kdb-service: 0.6.2 (commit b039218-dirty, built 2026-10-11T22:37:28Z, go1.26.3 darwin/arm64) (/Users/davidj/devel/kdb/go/bin/kdb-service)
kdb-client:  /Users/davidj/devel/kdb/packages/kdb-client/src/index.ts
kdb commit:  37d7f98ce6c1 
qtask:       0.1.61 ff4fd596e3ee-dirty
```
- The machine was in normal use during the run (other applications and a kdb development checkout were running), so treat absolute numbers as indicative and the shape across sizes as the finding.

## Method

- **Cold start** = a fresh data folder (identity, secrets and the store are created during the launch), 5 runs, each in its own folder. Not an OS-cold start: the files of a previous run are in the page cache, and `purge` needs root. Times are from the harness's `spawn()` to the event.
- **First contentful paint** is the web view's `first-contentful-paint` entry converted to wall-clock time. **Shell on screen** is the client's header present in the DOM. The page's first requests wait for the backend, so web view start-up and backend start-up overlap.
- **API latency** is per request, in milliseconds, **p50 / p95**, over 100 list, 100 create, 100 update, 60 search and 50 project-list requests (40/30/30/30/20 from 20,000 tasks on, where each request takes long enough that the run would otherwise take hours; the sample counts are in the table), issued one at a time, at each store size. Two layers:
  - *backend*: the harness talks straight to the local server's loopback port with the device token (Node + KDB only);
  - *page*: the same requests issued by `fetch()` in the web view, through the bridge to native code to the server (what the UI pays).
- **List** is `GET /api/tasks?limit=200` (the client's page size); **deep page** is the same with an offset of half the store. **Search** alternates three queries (a word in 1% of tasks, a common word, a two-word query). **Create** and **update** write one task per request, acknowledged after the store's fsync.
- Store sizes are reached with the app stopped: kdb-service is started on the data folder and tasks are written through the data layer (`e2e/macos/seed.mts`, the same schema normalisation as the API, spread over 20 projects, no activity-log entries), on one store that grows from size to size. Creating them over HTTP was tried first and abandoned: it seeded 500 tasks at 34 per second, and a run that then tried to add 1,500 more had not finished after eight minutes, with kdb-service near 140% CPU, because the store reads the whole collection for many writes. The latency samples add and edit a few hundred tasks, so the true count is shown.
- **Memory** is resident set size from `ps`: the app, the Node child and the kdb-service child, plus the WebKit processes that appeared while the app ran (WebContent, Networking, GPU; attributed by "not present before launch", so another application starting a web view during the run would be counted). RSS double counts shared pages.

## Cold start (fresh data folder, median of 5, ms)

| Metric | Median (min, max) |
|---|---|
| spawn to window shown | 197.53 (min 171.47, max 1113.52) |
| spawn to first contentful paint | 618 (min 578, max 1595) |
| spawn to shell on screen | 660 (min 605, max 1620) |
| spawn to backend ready (store + Node) | 574.14 (min 528.5, max 1556.8) |
| kdb-service start (spawn to listening) | 67.57 (min 55.44, max 128.57) |
| Node start (spawn to ready) | 241.38 (min 227.97, max 285.53) |

Idle memory after a cold start (median, MB): app 100.55, Node 131.34, kdb-service 29.52, WebKit 99.75; **total 360.84** (261.33 without WebKit).

## API latency by store size (p50 / p95 ms)

| | 1,000 tasks | 4,000 tasks | 8,000 tasks |
|---|---|---|---|
| actual tasks at start of sampling | 1000 | 4000 | 8000 |
| samples per op (list / create / update / search) | 100 / 100 / 100 / 60 | 100 / 100 / 100 / 60 | 100 / 100 / 100 / 60 |
| seeding rate (tasks/s, through the data layer) | 3086 | 1416 | 1357 |
| **backend** list (200) | 27.27 / 29.81 | 112.67 / 247.18 | 231.58 / 578.27 |
| backend list, deep page | 26.42 / 27.63 | 108.77 / 130.49 | 229.16 / 258.95 |
| backend project list | 16.34 / 23.6 | 56.91 / 62.54 | 108.98 / 120.48 |
| backend create | 79.94 / 86.32 | 254.05 / 277.94 | 512.37 / 542.78 |
| backend update | 73.65 / 100.03 | 207.51 / 230.6 | 415.3 / 439.33 |
| backend search | 33.59 / 38.35 | 120.42 / 138.89 | 248.38 / 267.56 |
| **page** list (200) | 31 / 33 | 114 / 138 | 239 / 271 |
| page project list | 20 / 22 | 61 / 70 | 117 / 128 |
| page create | 89 / 97 | 272 / 296 | 530 / 565 |
| page update | 78 / 84 | 226 / 255 | 421 / 451 |
| page search | 38 / 47 | 127 / 153 | 253 / 271 |

## Memory by store size (MB, RSS)

| | 1,000 tasks | 4,000 tasks | 8,000 tasks |
|---|---|---|---|
| app, after the load | 95.16 | 87.45 | 102.31 |
| Node, after the load | 432.52 | 862.69 | 2044.81 |
| kdb-service, after the load | 51.3 | 74.11 | 116.14 |
| WebKit, after the load | 126.28 | 174.88 | 287.17 |
| **total, after the load** | 705.25 | 1199.13 | 2550.44 |
| total, idle just after launch | 508.27 | 872.63 | 1188.34 |
| Node, idle just after launch | 241.39 | 639.53 | 872.8 |
| kdb-service, idle just after launch | 41.16 | 66.33 | 113.63 |
| store on disk (MB) | 1.07 | 6.1 | 11.68 |

## Launch on an existing store, and quit, by store size (ms)

| | 1,000 tasks | 4,000 tasks | 8,000 tasks |
|---|---|---|---|
| quit (menu quit to process exit) | 308 | 279 | 715 |
| first launch after the import: spawn to shell on screen | 1873 | 19271 | 92554 |
| relaunch after the sampling (ordinary use): spawn to shell on screen | 6330 | 30935 | 111966 |
| launch: spawn to window shown | 192.13 | 209.86 | 204.85 |
| launch: spawn to backend ready | 570.98 | 723.25 | 723.12 |
| launch: spawn to first contentful paint | 1935 | 25710 | 92945 |
| launch: spawn to shell on screen | 2001 | 25917 | 92978 |
| first task page (200), asked right after that | 63 | 310 | 701 |



## Limits found while measuring (manual runs outside this script; the numbers are as observed)

The requested sizes of 10,000 and 50,000 tasks could not be measured, because the KDB store the
app ships with does not hold them correctly. This is why the table stops at 8000 tasks.

1. **Documents beyond 10,000 per store are invisible, silently.** kdb-service v0.6.2 (the build in the
   app) caps a non-indexed scan at its first 10,000 documents *before* applying the `WHERE`, with no error
   (this is the defect described in `kdb/docs/kdb-scan-cap-plan.md`, fixed on kdb's
   `fix/scan-cap-before-filter`, not in the binary used here). One namespace holds every collection, so
   tasks, projects, activity entries and users share the 10,000. Observed in the app: 10,000 tasks
   imported, then `GET /api/tasks` reported `total: 9998` (the other two slots were the user and the
   default project), and a task created afterwards was written but could not be read back
   (`GET`/`PATCH` of it answered 404, 40 of 40 times). At 2,000, 4,000, 6,000 and 8,000 imported tasks the
   same create-then-update check passed 40 of 40. The newer kdb behaviour turns the silent truncation into a
   `RESOURCE_EXHAUSTED` error on any result over 10,000 rows, which would fail every list instead.
   Either way the store's design (every query reads the whole collection and filters in Node, see the comment
   at the top of `src/data/kdb/store.ts`) cannot go past 10,000 documents; it needs the SQL pushdown that
   file calls `DATA_KDB_PUSHDOWN`, or another store.
2. **Reopening a store costs time quadratic in its size.** Measured against a bare kdb-service (no qtask code),
   one task per commit, seeded and then restarted with a clean SIGTERM: the first full read after the restart took
   0.95 s at 1,000 documents, 3.6 s at 2,000, 8.0 s at 3,000 and 53 s at 8,000 (later reads: milliseconds). In
   the app, the launch on a 10,000-task store took 117 s before the UI appeared (the page's first requests wait for
   that read), and the kdb client's default 30 s deadline made those first requests fail until the app raised it
   (`KDB_REQUEST_TIMEOUT_MS`, set by `src/local/entry.ts`). The `--maintenance-interval 5s` flag did not
   change the 3,000-document result. Extrapolating this to 50,000 would be a guess, so none is given.
3. Both are in KDB, which this work does not modify; they are reported to its owner with the recipe above
   (`SELECT` after a restart; 12,000 upserts for the cap).

Helper processes left running after the final quit: 0.
