# MongoDB vs KDB through qtask's data layer

A reproducible comparison of the two data backends qtask can run on, each in a Docker container
with the same limits (**2 CPUs, 4 GB RAM, no swap** by default), loaded with the same
qtask-shaped dataset and driven through **qtask's own data layer** (`connectData()` and
`collection()` from `src/data`, the store code the app runs) with the operations qtask's services
actually issue.

```bash
# The full run (do this on an otherwise idle machine)
npm run bench:docker -- --scale prod --duration 120

# A smoke run that only checks the harness works (a few minutes)
npm run bench:docker -- --scale smoke
```

Results land in `bench/results/<timestamp>-<scale>/`: `results.json` (everything, machine
readable), `report.md` (tables) and `report.html` (the same, plus throughput and p99 charts).
`raw/` holds each client process's output, including mergeable latency histograms.
`--report-only <dir>` re-renders a report from an existing `results.json`.

Requirements: Docker (Docker Desktop is fine), `npm install`, network access the first time
(pulls `mongo:7` and `alpine:3.20`, downloads the KDB release binary). Ports 8411-8413 on
127.0.0.1. Everything the harness creates is named `qtask-bench-*`; it never touches other
containers.

## What it does

1. **Dataset** (cached between runs, keyed by scale, seed and overrides). Generates a
   deterministic qtask dataset (`lib/dataset.ts`) and inserts it into MongoDB through the app's
   own Mongoose models (cast and validated like any app write). Then copies MongoDB into KDB with
   the app's own migration tool, `src/scripts/migrate-mongo-to-kdb.ts backfill`, so both hold
   identical documents; optionally runs its `verify` (default on below `prod`); then
   **cross-checks** a set of hot queries on both stores and compares the answers document by
   document (`compareDocLists`, the shadow-read comparator). Both data volumes are then
   snapshotted ("pristine").
2. **Measurement**, one database at a time (the other container is not running). For each
   backend and profile: restore the pristine volume, start the container with the limits, then
   for each concurrency level run a cell: start the client processes, a short startup grace and
   a warmup, then a fixed measured window. Container CPU and memory are sampled from
   `docker stats` over exactly the window; disk usage is taken from the volume after each profile.
3. **Cold start**: stop the container, drop the VM's page cache (best effort), `docker start`,
   and time until a fresh client has connected and answered its first `/me` and task list.
4. **fsync probe**: 4 KiB `dd oflag=dsync` on the data volume, so the report shows what a durable
   commit costs on this disk.

### Backends

| name | what | durability |
|---|---|---|
| `mongo` | `mongo:7`, image defaults (WiredTiger, journal on) | `w:1`, the app's default: acknowledged before the journal is flushed (it flushes every 100 ms) |
| `mongo-j` | same container | `w:1, j:true`: acknowledged after the journal fsync |
| `kdb` | `kdb-service` v0.8.0 | `--durability sync`: acknowledged after fsync (group commit) |
| `kdb-async` | same | `--durability async`: acknowledged once queued, synced every 5 ms |

The like-for-like pairs are `mongo`/`kdb-async` (neither waits for a disk flush) and
`mongo-j`/`kdb` (both do).

KDB runs as `deploy/qtask-kdb.service` runs it: `--namespace qtask/docs --peer-addr ""
--stream-addr "" --expire-field _expireAt --expire-interval 1m`, data in a container volume. The
app side uses what docs/KDB_MIGRATION.md tells a deployment to use: `DATA_KDB_PUSHDOWN=true`,
constraints and lookup indexes declared (`DATA_KDB_DECLARE_CONSTRAINTS`, `DATA_KDB_DECLARE_INDEXES`,
both default on).

**The KDB image.** `ghcr.io/dbeasty/kdb/kdb-service:v0.9.1` is published for linux/amd64 only.
On an arm64 Docker engine (Apple silicon) it would run under emulation and measure the emulator,
so the harness builds an equivalent image (`docker/kdb-service.Dockerfile`: same alpine 3.20 base,
user, entrypoint, volume and ports as the published one, checked with `docker history`) around the
same release's checksum-verified `kdb-service-linux-arm64` binary. On amd64 it uses the
published image unchanged. The report records which.

### Client side

The load generator runs on the host, outside the limits: by default up to **4 Node processes**
per cell (`--clients`), with the cell's simulated users split evenly over them, so the client is
not the bottleneck (one process saturates a core well before MongoDB does - the Mongoose read path
decoding 768-dimension embeddings is not cheap). The report shows client CPU summed and for the
busiest process; near 100% for one process means that cell measured the client.

Consequence for KDB: the KDB store's per-document and per-collection locks are **in-process**
(`withLock` in src/data/kdb/store.ts). With several client processes, KDB is exercised the way a
multi-instance deployment would exercise it: atomicity across processes comes from the server's
conditional writes (`replaceIf` on a content hash) and server-side unique constraints. A single
app instance is `--clients 1`; run that too if that is the deployment you care about.

Each cell's actions are a closed loop: every simulated user issues its next action as soon as the
last one finishes (no think time), so throughput is the maximum the system sustains at that
concurrency and latency is what each request saw at that load.

### Files

- `docker.ts` - the orchestrator (`npm run bench:docker`)
- `worker.ts` - one client process: dataset load, a measured cell, claim test, cold start, cross-check
- `lib/workload.ts` - the actions and profiles; `lib/dataset.ts` - the generator; `lib/docker.ts` -
  containers, volumes, stats, fsync probe, the KDB image; `lib/report.ts`; `lib/stats.ts`
- `probe-ops.ts`, `probe-sql.ts` - diagnostics: single data-layer calls, and the SQL the KDB store
  pushes down, timed one at a time against a running backend

## The workload model (derived from the code)

Everything below is replayed as data-layer calls with the filters, sorts, limits, projections and
update operators the service uses, in the same order and with the same parallelism
(`lib/workload.ts`, each method cites its source). HTTP, JWT checks, serialisation, in-process
search scoring, Ollama, email and object storage are left out: they cost the same on either
database.

### Facts about qtask's data access that shape the model

- **No multi-document transactions.** `grep -rnE "startSession|withTransaction" src/` finds
  nothing, nor does any `session` option outside src/sync and src/data. qtask's "transactions" are
  (a) atomic single-document read-modify-writes - `findOneAndUpdate` claims and conditional
  `updateOne`s - and (b) multi-step service operations (create a task, then enqueue, then log, then
  roll the project up) with in-process promise locks (`withTaskSaveLock` taskService.ts:49,
  `withDefaultProjectLock` projectService.ts:79) and no rollback.
- **Task edits are whole-document replaces.** Every task mutation loads the task, changes it in
  JS and writes it back with `tasks.replaceOne({_id}, fullDoc)` (taskService.ts:85, :797, :815).
  No route issues `$push`, `$pull` or positional `$` on tasks. Positional `$` appears once in the
  app (conversations, conversationService.ts:292); `$push` only on conversations; `$inc` in the
  queue claims and LLM metrics.
- **Task lists return whole documents, embeddings included.** Tasks and projects carry a
  768-number `embedding` (nomic-embed-text) once the embedding worker has run, and the list,
  search and workload reads do not project it away.
- **Every project rollup reads all of a project's tasks, twice.** `recalculateProjects`
  (projectService.ts:851) runs after every task create, update and delete: per project and
  ancestor, a status rollup (:901, `tasks.find` of the project's tasks, :921) and a tracking
  rollup (:956, a second `tasks.find`, :988), plus four project reads and two project updates.
- **The access filter is a disjunction.** Projects visible to a user:
  `{staging:{$exists:false}, $or:[{userId},{'collaborators.userId':userId}]}`
  (projectService.ts:280). Tasks: `{$or:[{userId},{projectIds:{$in:pids}},{projectId:{$in:pids}}],
  staging:{$exists:false}}` (taskService.ts:232, :480). Almost every read goes through one of the
  two.
- **Auth is mostly stateless.** Web requests verify a JWT with no lookup and touch
  `users.lastActiveAt` at most once per user per 15 minutes per process (middleware/auth.ts:12-24).
  MCP requests with an API key do a `findOneAndUpdate` on `mcpApiKeys` by `keyHash` on every
  request (mcpKeyService.ts:73), then an `mcpSessions` lookup and touch (mcpSessionService.ts:44,
  :52). There is no web session collection; "sessions by token" means these.
- **Queues have no poll interval.** The embedding and feedback-vision workers drain on enqueue,
  one job at a time per process. Claims, exactly:
  - embedding (embeddingQueue.ts:158-162): `findOneAndUpdate({status:'pending', attempts:{$lt:3}},
    {$set:{status:'processing'}, $inc:{attempts:1}}, {sort:{createdAt:1}, returnDocument:'after'})`
  - vision (feedbackVisionQueue.ts:68-72): `findOneAndUpdate({status:'pending'}, {$set:
    {status:'processing'}, $inc:{attempts:1}}, {sort:{updatedAt:1}, returnDocument:'after'})`

### Actions

One action = one user-visible request. "calls" is the number of data-layer calls it makes in the
dataset as generated (rollups depend on project size; `P` = projects on the task).

| action | source | data-layer calls |
|---|---|---|
| `listTasks` (GET /api/tasks, limit 200; 35% filtered by project, 30% by open status, 10% second page) | routes/tasks.ts:184, taskService.ts:470-555 | [project access findOne] + projects.find(access, select _id) + **parallel** tasks.find(q, sort {sortOrder,createdAt:-1,_id}, limit 200, skip) and tasks.countDocuments(q) |
| `getTask` (task page: task + comments) | taskService.ts:287; commentService.ts:195-199, :55 | tasks.findById + P x projects.findOne(access) + comments.find(root, sort createdAt) + users.find($in, select) |
| `taskActivity` | activityService.ts:24 | load task (as above) + activities.find({taskId}, sort -createdAt, limit 50) |
| `listProjects` | projectService.ts:647, :252-254, :145 | projects.countDocuments + projects.findOne(sort createdAt) + projects.find(access, sort) + users.find($in) |
| `unreadCount` (polled by every open client) | notificationService.ts:81 | notifications.countDocuments({userId, read:false}) |
| `listNotifications` | notificationService.ts:69 | notifications.find({userId}, sort -createdAt, limit 50) |
| `markNotificationsRead` | notificationService.ts:69, :85, :105 | list + (70%) findOneAndUpdate one / (30%) updateMany all unread |
| `search` (GET /api/search) | searchService.ts:335, :41, :245, :200 | projects.find(access) + **parallel** task arm (tasks.find(base, sort updatedAt -1, limit 500), tasks.find(base + embedding exists, same), projects.find names) and project arm (two projects.find, limit 500) |
| `workload` | taskService.ts:842 | projects.find(access) + tasks.find(open, no sort, no limit) |
| `me` | authService.ts:613 | users.findById |
| `login` | authService.ts:197, :217 | users.findOne({email}) + users.replaceOne (lastLoginAt) |
| `mcpFindTasks` (one MCP request, find_tasks in the active project) | mcpKeyService.ts:73; mcpSessionService.ts:44, :52; tools.ts:293; taskService.ts:569 | mcpApiKeys.findOneAndUpdate + mcpSessions.findOne + mcpSessions.updateOne + project access + projects.find(access) + tasks.find(q, sort, **no limit**) |
| `listConversations` | conversationService.ts:131 | conversations.find({userId}, sort -updatedAt, select) |
| `updateTask` (status 30%, percent 20%, toggle step 30%, add step 10%, title 10%) | taskService.ts:590-691 | load task + **tasks.replaceOne(whole doc)** + enqueue (embeddingJobs.updateOne x1-2) + activities.create + rollup (per project: 4 project reads, 2 project-task scans, 2 project updates) |
| `createTask` (0-6 steps, 25% with a subtask) | taskService.ts:355-440 | project access + tasks.findOne(min sortOrder) + tasks.create + enqueue + activities.create + rollup |
| `addComment` | commentService.ts:211-307 | load task + comments.create + activities.create + users.findById + [projects.findById + users.find + notifications.create per recipient] + enqueue |
| `agentTurn` (persistence of one agent chat turn; no LLM) | conversationService.ts:119, :235 | conversations.find + findOne + findOneAndUpdate($set whole messages) + findOne |
| `createProject` | projectService.ts:491-557 | projects.findOne(max sortOrder) + projects.create + enqueue + findById + users.find |
| `deleteTask` (only tasks the run created) | taskService.ts:693-711 | load task + tasks.deleteOne + **comments.deleteMany** + activities.create + rollup |
| `register` | authService.ts:150-160; projectService.ts:250 | users.findOne + users.create (unique email) + projects.countDocuments + projects.create |
| `bg:embeddingJob` (background, one lane, every workload profile) | embeddingQueue.ts:158-239 | claim + tasks.findById + projects.find + comments.find + users.find + (Ollama: fixed delay, `--ollama-delay`, default 100 ms) + tasks.updateOne($set embedding) + finish (1-2 conditional updateOne) |

Plus, once per user per client process, the `users.updateOne($set lastActiveAt)` that auth
middleware fires without awaiting (the 15-minute throttle is longer than a run).

Not modelled (rare, or dominated by something else): project update/delete/share/invite flows,
subtask moves, reorder, staging commits, OAuth flows, admin pages (`/stats` reads ten whole
collections - the heaviest query in the app, but an operator page), LLM metrics writes.

### Profiles

qtask has no request telemetry to take a mix from, so the mix is modelled on what the client
does: every open screen polls the unread count; navigation lists tasks and projects; opening a
task loads it and its comments; edits are a minority. Per 100 actions:

| action | mixed | read-heavy | write-heavy |
|---|---|---|---|
| listTasks | 18 | 18 | 6.3 |
| getTask | 14 | 14 | 4.9 |
| unreadCount | 12 | 12 | 4.2 |
| listProjects | 7 | 7 | 2.45 |
| mcpFindTasks | 6 | 6 | 2.1 |
| search | 4 | 4 | 1.4 |
| me | 3 | 3 | 1.05 |
| listNotifications | 3 | 3 | 1.05 |
| taskActivity, workload | 2 each | 2 each | 0.7 each |
| login, listConversations | 1 each | 1 each | 0.35 each |
| updateTask | 12 | 2.4 | 36 |
| createTask, addComment | 4 each | 0.8 each | 12 each |
| markNotificationsRead | 3 | 0.6 | 9 |
| agentTurn | 2 | 0.4 | 6 |
| deleteTask | 1 | 0.2 | 3 |
| createProject | 0.5 | 0.1 | 1.5 |
| register | 0.2 | 0.04 | 0.6 |

By action, mixed is 73% reads / 27% writes (read-heavy 93/7, write-heavy 24/76). Because a
write action is several calls (an update is ~14, most of them its rollup reads), the ratio **at the data-layer call level** is
different, and is measured rather than assumed: the report prints it per cell ("reads:writes").
Read-heavy (writes x0.2) is a team browsing and polling; write-heavy (reads x0.35, writes x3) is a
bulk planning session or an agent creating and editing tasks.

`claim` is the contention test: N workers (the concurrency level) claim from one queue
(`feedbackVisionJobs`, the claim above), complete the job and re-enqueue it (the app's own
enqueue, feedbackVisionQueue.ts:28-48), so the queue depth stays constant for the whole window.
It reports claims/s, cycle latency, the claim's own latency, **empty claims** (a claim that found
nothing although jobs were pending), and checks integrity: **double claims** (the same
(job, attempts) pair claimed twice, across all client processes - each claim increments
`attempts` atomically, so a duplicate means two claims of one job from the same state) and jobs
left `processing` after every worker stopped. The vision queue is used rather than the embedding
queue because the embedding claim requires `attempts < 3` and re-enqueueing never resets
`attempts`, so a re-enqueued job is never claimable again after three runs (see Open issues).

## Dataset

`--scale` picks a preset (`lib/dataset.ts`); `--users`, `--tasks` and `--embedding-dims`
override it. Shapes follow src/models/index.ts.

| | smoke | small | prod |
|---|---|---|---|
| users | 40 | 200 | 1,000 |
| tasks | 1,500 | 10,000 | 100,000 |
| projects | ~4/user | ~5/user | ~5/user (30% shared with 1-3 collaborators, 15% nested) |
| comments | 0.5/task | 0.5/task | 0.5/task |
| activities | 2/task | 2/task | 2/task |
| notifications | ~30/user | ~40/user | ~50/user |
| embedding jobs | 1/task (+ pending) | | 20,000 pending |
| conversations | 2/user | 3/user | 3/user, 2-16 messages |
| MCP keys / sessions | 1 per 3 users / 2 per key | | |
| embeddings | 768 dims on 90% of tasks and projects | | |

Task count per user is skewed (a power law over users), and so is which user a simulated session
acts as: a few users are much busier than the rest. Tasks have 0-8 steps, 25% have 1-4 subtasks
(with steps), 20% have material lines, 50% a due date, 0-3 tags. Every id is derived from
(collection, ordinal), with ObjectId timestamps following `createdAt`, so the same seed gives the
same bytes.

## Options

| flag | default | |
|---|---|---|
| `--scale` | `prod` | `smoke`, `small`, `prod` |
| `--duration` | 120 (smoke 10) | measured seconds per cell |
| `--warmup` | 15 (smoke 3) | unmeasured seconds per cell, after every client process has connected |
| `--concurrency` | `1,8,32,64` (smoke `1,8`) | simulated users (claim: workers) per cell |
| `--profiles` | `mixed,read-heavy,write-heavy,claim` | |
| `--backends` | `mongo,mongo-j,kdb,kdb-async` | |
| `--clients` | 4 | client processes per cell (at most one per simulated user) |
| `--cpus`, `--memory` | 2, `4g` | container limits (`--memory-swap` = `--memory`) |
| `--reset` | `profile` | restore pristine data before every `profile` or every `cell` |
| `--ollama-delay` | 100 | ms the background embedding worker spends "in Ollama"; -1 disables it |
| `--cold-runs` | 3 (smoke 1) | cold starts per backend |
| `--seed` | 42 | |
| `--reuse-data` | true | reuse the cached dataset and pristine volumes if present |
| `--verify-load` | true below prod | run `migrate:kdb verify` after the backfill |
| `--crosscheck-users` | 25 (prod 3) | users the cross-check asks about |
| `--users`, `--tasks`, `--embedding-dims` | preset | dataset overrides |
| `--out` | `bench/results/<stamp>-<scale>` | |
| `--report-only <dir>` | | re-render report.md/html from results.json |

`BENCH_DRAIN_TIMEOUT_MS` (default 60000): how long a cell waits for in-flight actions after the
window closes before abandoning them; they are reported as "unfinished".

### Expected duration of the full run

Per backend: 3 workload profiles + claim, 4 concurrency levels each, (connect + 15 + 120) s per cell
= 16 cells x ~2.4 min ≈ 37 min, plus restores and cold starts ≈ 40 min. Four backends ≈ **2 h 40
min**, plus building the prod dataset once. That part has not been run at prod scale yet (only
smoke was validated): the MongoDB load ran at ~6,000 docs/s on smoke, so ~600k documents should
take a few minutes; the KDB backfill took 11 s for 8,465 documents with `--durability async`,
which extrapolates to ~15 min if it scales linearly; the cross-check asks 3 users ~12 questions
each, and on KDB each access-filter query is a full scan (see below), so budget tens of minutes.
The dataset is cached, so later runs skip all of it. A slow backend also adds up to
`BENCH_DRAIN_TIMEOUT_MS` per cell. To shorten: `--backends mongo-j,kdb` (the durable pair)
halves it; `--duration 60` roughly halves it again. Building the dataset alone first is
`--profiles mixed --concurrency 1 --duration 5 --backends mongo --cold-runs 0`.

## Open issues and threats to validity

- **KDB answers the access-filter disjunction with a full scan.** Measured on the smoke dataset
  (8,465 documents) through @limidus/kdb-client against the container (`bench/probe-sql.ts`):
  `userId = ?` 8.6 ms, `collaborators.userId = ?` 0.8 ms, but
  `(userId = ? OR collaborators.userId = ?)` 338 ms; the task access filter
  (`userId = ? OR projectIds IN (...)`) 416 ms; `email = ?` (unique, but carried on a synthetic
  `_u_users_email` field and not indexed under `email`) 343 ms. KDB holds every collection in one
  namespace, so each such scan reads every document of every collection, embeddings included,
  and its cost grows with the whole database. Nearly every qtask read starts with an access
  filter, and every `users` write runs the in-process unique check (`assertUnique`) as an email
  lookup. Expect KDB at `prod` scale to be dominated by this - scans of ~600k documents - and
  possibly to hit the client's 30 s request timeout (counted as errors). That is a finding about
  qtask on KDB 0.8.0 as configured today (pushdown turns `$or` into SQL `OR`, which the server
  does not answer from its indexes), not a harness artefact; a store that split the `$or` into
  per-branch indexed lookups, and indexed `email`, would change the picture.
- **KDB store write serialisation.** For collections with unique constraints (users,
  embeddingJobs, feedbackVisionJobs, mcpApiKeys, invites, ...), every write in a process takes one
  collection-wide lock (`guardUnique`), so those writes are serialised per client process.
- **Embedding claim never retries after 3 runs** (a qtask bug, not a benchmark one):
  `enqueueEntityEmbeddingJob` (embeddingQueue.ts:56-66) sets `status:'pending'` but only sets
  `attempts` on insert, while the claim requires `attempts < 3`. A task embedded three times (three
  edits) gets a pending job that is never claimed again, so its embedding goes stale.
- **Docker Desktop.** The databases run in a Linux VM; host-to-container traffic goes through
  Docker's port proxy (adds latency equally to both), and the data volume is the VM's virtual
  disk, whose fsync cost is not a server SSD's (the fsync probe shows it). Absolute numbers will
  differ on a Linux server; ratios between backends are the more portable result, and even they
  depend on the disk for the durable pair.
- **The client is outside the limits.** Only the databases are capped. The KDB store does
  filtering, sorting and projection in the client process (that is its design), so part of KDB's
  cost lands on the client's CPU, which is not capped. The report shows client CPU so this is
  visible; it is the cost the app server would pay.
- **Multiple client processes change KDB's locking** (see Client side). `--clients 1` measures a
  single app instance.
- **Data drift within a profile.** Concurrency levels within a profile run in ascending order on
  the same data, so later cells see the writes of earlier ones (a faster backend accumulates more).
  `--reset cell` restores pristine data before every cell, at the cost of a cold cache each time.
- **Busy machine.** Other processes on the host or in the Docker VM skew results. Run the full
  benchmark when the machine is otherwise idle.
- **MongoDB loads through Mongoose's `insertMany`** with `timestamps: false` (so generated dates
  survive), not through `collection().insertMany` (which would re-stamp them).
- **The mix is a model.** There is no production telemetry; profiles are a reasoned guess, which
  is why read-heavy and write-heavy exist.
