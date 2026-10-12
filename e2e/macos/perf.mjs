#!/usr/bin/env node
// Performance measurements for the Mac app (client-macos), on the real built app.
//
//   E2E=1 scripts/build-macos.sh && node e2e/macos/perf.mjs
//
// Writes docs/perf/phase1.json (raw samples summary) and docs/perf/phase1.md (the report).
// Everything in the report is a number this script measured; nothing is estimated.
//
// What is measured
//   * cold start: first launch on an empty data folder, spawn -> first contentful paint and
//     spawn -> shell on screen, N=COLD_RUNS fresh folders;
//   * for each data size (SIZES, default 1000,4000,8000 tasks; 10,000 and 50,000 are not
//     measurable on this store, see the report's "Limits found" section), on the same growing store:
//       - API latency p50/p95 for list, create, update, search (and the project list), at two
//         layers: directly against the local server (the backend alone) and from the page
//         through the bridge (what the UI pays);
//       - memory (RSS) of the app, node and kdb-service, and of the WebKit processes that
//         appeared with the app, at idle and after the load;
//       - relaunch time (quit -> window with UI on screen), quit time, store size on disk.
//
// Environment: PERF_SIZES="1000,4000,8000"  PERF_COLD_RUNS=5  PERF_SEED_CONCURRENCY=24
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { taskFields } from './taskgen.mjs';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Instance, ROOT, backendClient, helperPids, makeWork, prepareApp, rssKb, sleep } from './lib.mjs';

const SIZES = (process.env.PERF_SIZES || '1000,4000,8000').split(',').map(Number);
const COLD_RUNS = Number(process.env.PERF_COLD_RUNS || 5);
const SAMPLES = { list: 100, create: 100, update: 100, search: 60, projects: 50, deep: 30 };
const BIG_SAMPLES = { list: 40, create: 30, update: 30, search: 30, projects: 20, deep: 10 };
const SINGLE_LAUNCH_FROM = 50000; // opening this store takes tens of minutes, so only one launch is measured
const LARGE_FROM = 20000; // from this many tasks on, each request is slow enough that fewer samples are taken
const WORK = makeWork('qtask-macos-perf-');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const summary = (arr) => ({ n: arr.length, p50: round(pct(arr, 50)), p95: round(pct(arr, 95)), max: round(Math.max(...arr)) });
const round = (x) => Math.round(x * 100) / 100;

function machine() {
  const sh = (c, a) => {
    try {
      return execFileSync(c, a, { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  };
  return {
    model: sh('sysctl', ['-n', 'hw.model']),
    chip: sh('sysctl', ['-n', 'machdep.cpu.brand_string']),
    cores: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    macos: sh('sw_vers', ['-productVersion']),
    disk: sh('sh', ['-c', "diskutil info / | awk -F: '/Solid State|Device Location/ {gsub(/^ +/,\"\",$2); printf \"%s; \", $2}'"]),
  };
}

let seedCounter = 0;
function taskBody(projectIds) {
  return taskFields(seedCounter++, projectIds);
}

/** Fills the store to `target` tasks while the app is not running: kdb-service is started on
 *  the data folder from the app's own helpers and the tasks are written through the data layer. */
async function seedOffline(app, dataDir, target, userId, projectIds) {
  const from = seedCounter;
  if (target <= from) return { seeded: 0, seconds: 0, perSecond: null };
  const kdbPort = await freePort();
  const kdb = spawn(path.join(app, 'Contents/Resources/backend/kdb-service'), [
    '--data-dir', path.join(dataDir, 'kdb'), '--namespace', 'qtask/docs',
    '--sql-addr', `tcp://127.0.0.1:${kdbPort}?bind=true`, '--peer-addr', '', '--stream-addr', '', '--log-level', 'warn',
  ], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 300 && !(await canConnect(kdbPort)); i++) await sleep(50);
    const spec = { kdbPort, userId, projectIds, from, to: target, kdbClientModule: path.join(app, 'Contents/Resources/backend/kdb-client.mjs'), concurrency: 32 };
    const out = execFileSync('node', ['--import', 'tsx', path.join(ROOT, 'e2e/macos/seed.mts'), JSON.stringify(spec)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    seedCounter = target;
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    kdb.kill('SIGTERM');
    await new Promise((r) => kdb.once('exit', r));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function backendLatencies(client, ids, total) {
  const out = {};
  const time = async (n, fn) => {
    const ms = [];
    for (let i = 0; i < n; i++) ms.push(await fn(i));
    return summary(ms);
  };
  await client.call('GET', '/api/tasks?limit=200'); // warm connection and JIT
  out.list = await time(SAMPLES.list, async () => (await client.call('GET', '/api/tasks?limit=200')).ms);
  out.listDeepPage = await time(SAMPLES.deep, async (i) => (await client.call('GET', `/api/tasks?limit=200&offset=${Math.floor(total / 2) + i * 200}`)).ms);
  out.projects = await time(SAMPLES.projects, async () => (await client.call('GET', '/api/projects')).ms);
  out.create = await time(SAMPLES.create, async (i) => {
    const r = await client.call('POST', '/api/tasks', taskBody(ids.projectIds));
    if (r.status !== 201) throw new Error(`create ${r.status}`);
    ids.push(r.body.task._id);
    return r.ms;
  });
  out.update = await time(SAMPLES.update, async (i) => {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const r = await client.call('PATCH', `/api/tasks/${id}`, { title: `edited ${i} ${Date.now()}` });
    if (r.status !== 200) throw new Error(`update ${r.status}`);
    return r.ms;
  });
  const queries = ['zebra', 'invoice', 'garage budget'];
  out.search = await time(SAMPLES.search, async (i) => (await client.call('GET', `/api/search?q=${encodeURIComponent(queries[i % queries.length])}`)).ms);
  return out;
}

async function pageLatencies(inst, ids) {
  const sample = ids.slice(-400);
  const src = `
    const tok = localStorage.getItem('qtask_token');
    const h = { 'content-type': 'application/json', authorization: 'Bearer ' + tok };
    const time = async (n, fn) => { const ms = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); const r = await fn(i); if (r.status >= 300) throw new Error('status ' + r.status); await r.text(); ms.push(performance.now() - t0); } return ms; };
    const ids = ${JSON.stringify(sample)};
    const projectIds = ${JSON.stringify(ids.projectIds)};
    await fetch('/api/tasks?limit=200', { headers: h });
    const out = {};
    out.list = await time(${SAMPLES.list}, () => fetch('/api/tasks?limit=200', { headers: h }));
    out.projects = await time(${SAMPLES.projects}, () => fetch('/api/projects', { headers: h }));
    out.create = await time(${SAMPLES.create}, (i) => fetch('/api/tasks', { method: 'POST', headers: h, body: JSON.stringify({ title: 'page created ' + i, projectId: projectIds[i % projectIds.length] }) }));
    out.update = await time(${SAMPLES.update}, (i) => fetch('/api/tasks/' + ids[i % ids.length], { method: 'PATCH', headers: h, body: JSON.stringify({ title: 'page edited ' + i + ' ' + Date.now() }) }));
    const queries = ['zebra', 'invoice', 'garage budget'];
    out.search = await time(${SAMPLES.search}, (i) => fetch('/api/search?q=' + encodeURIComponent(queries[i % 3]), { headers: h }));
    return out;`;
  const raw = await inst.command('js', src, 30 * 60 * 1000);
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = summary(v);
  return out;
}

function psTable() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m && { pid: +m[1], ppid: +m[2], rssKb: +m[3], command: m[4] };
    })
    .filter(Boolean);
}
const webKitPids = () => new Set(psTable().filter((p) => /com\.apple\.WebKit\.(WebContent|Networking|GPU)/.test(p.command)).map((p) => p.pid));

function memory(state, webBefore) {
  const mb = (kb) => round(kb / 1024);
  const app = rssKb(state.appPid), node = rssKb(state.nodePid), kdb = rssKb(state.kdbPid);
  const table = psTable();
  const web = [...webKitPids()].filter((p) => !webBefore.has(p)).map((p) => table.find((r) => r.pid === p)).filter(Boolean);
  const webKb = web.reduce((a, r) => a + r.rssKb, 0);
  return {
    appMB: mb(app), nodeMB: mb(node), kdbMB: mb(kdb), webKitMB: mb(webKb), webKitProcesses: web.length,
    totalMB: mb(app + node + kdb + webKb),
    totalWithoutWebKitMB: mb(app + node + kdb),
  };
}

const dirSizeMB = (dir) => {
  try {
    return round(Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0]) / 1024);
  } catch {
    return null;
  }
};

async function launchTimes(inst, spawnedAt) {
  const uiAt = await inst.waitForUi(20 * 60 * 1000);
  const t = await inst.js(`
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { fcpEpoch: fcp ? performance.timeOrigin + fcp.startTime : null, now: Date.now() };`);
  const s = await inst.state();
  const mark = (tl, name) => (tl.find((x) => x.name === name) || {}).t;
  return {
    spawnToFirstContentfulPaintMs: t.fcpEpoch ? round(t.fcpEpoch - spawnedAt) : null,
    spawnToShellOnScreenMs: uiAt - spawnedAt,
    spawnToWindowMs: round(mark(s.timeline, 'window-shown') - spawnedAt),
    spawnToBackendReadyMs: round(mark(s.timeline, 'backend-ready') - spawnedAt),
    kdbStartMs: round(mark(s.supervisorTimeline, 'kdb-listening') - mark(s.supervisorTimeline, 'supervisor-start')),
    nodeStartMs: round(mark(s.supervisorTimeline, 'node-ready') - mark(s.supervisorTimeline, 'node-spawn')),
  };
}

async function main() {
  const app = prepareApp(WORK);
  const result = { machine: machine(), startedAt: new Date().toISOString(), sizes: SIZES, coldStart: [], bySize: {} };
  result.versions = readFileSync(path.join(app, 'Contents/Resources/backend/VERSIONS.txt'), 'utf8');
  result.appSizeMB = dirSizeMB(app);
  log('machine', JSON.stringify(result.machine));

  // ---- cold start: a fresh data folder each time
  for (let i = 0; i < COLD_RUNS; i++) {
    const dataDir = path.join(WORK, `cold${i}`);
    const inst = new Instance(app, dataDir, path.join(WORK, `coldctl${i}`));
    const webBefore = webKitPids();
    inst.start();
    const spawned = inst.spawnedAt;
    const t = await launchTimes(inst, spawned);
    await sleep(1500);
    const st = await inst.state();
    t.memoryIdle = memory(st, webBefore);
    result.coldStart.push(t);
    log(`cold run ${i + 1}/${COLD_RUNS}`, JSON.stringify({ fcp: t.spawnToFirstContentfulPaintMs, shell: t.spawnToShellOnScreenMs }));
    await inst.quit();
    rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- by size, on one store that grows. The app is stopped while tasks are added.
  const dataDir = path.join(WORK, 'data');
  let inst = new Instance(app, dataDir, path.join(WORK, 'ctl-setup'));
  inst.start();
  await inst.waitForUi();
  let state = await inst.state();
  let client = backendClient(state);
  const me = (await client.call('GET', '/api/auth/me')).body.user;
  const projectIds = [];
  for (let i = 0; i < 19; i++) {
    const r = await client.call('POST', '/api/projects', { name: `Perf project ${i}` });
    projectIds.push(r.body.project._id);
  }
  projectIds.push((await client.call('GET', '/api/projects')).body.projects.find((p) => p.name === 'Project One')._id);
  await inst.quit();

  for (const size of SIZES) {
    log(`== ${size} tasks: seeding (app stopped)`);
    Object.assign(SAMPLES, size >= LARGE_FROM ? BIG_SAMPLES : { list: 100, create: 100, update: 100, search: 60, projects: 50, deep: 30 });
    const entry = { tasks: size, samples: { ...SAMPLES } };
    try {
      entry.seed = await seedOffline(app, dataDir, size, me.id, projectIds);
      log(`  seeded: ${JSON.stringify(entry.seed)}`);
      entry.storeOnDiskMB = dirSizeMB(path.join(dataDir, 'kdb'));

      // The first launch after a bulk import recomputes project rollups for the imported
      // tasks (the import wrote none); measure it, then quit, so the next launch is the
      // steady state a user would see.
      if (size < SINGLE_LAUNCH_FROM) {
        const imp = new Instance(app, dataDir, path.join(WORK, `ctl-import-${size}`));
        imp.start();
        entry.launchAfterImport = await launchTimes(imp, imp.spawnedAt);
        await sleep(1000);
        await imp.quit();
      }

      entry.launchIsFirstAfterImport = size >= SINGLE_LAUNCH_FROM;
      // Launch on that data: the numbers a user waits for.
      const webBefore = webKitPids();
      inst = new Instance(app, dataDir, path.join(WORK, `ctl-${size}`));
      inst.start();
      const launch = await launchTimes(inst, inst.spawnedAt);
      const first = await inst.js(`
        const tok = localStorage.getItem('qtask_token');
        const t0 = performance.now();
        const r = await fetch('/api/tasks?limit=200', { headers: { authorization: 'Bearer ' + tok } });
        const j = await r.json();
        return { ms: performance.now() - t0, n: j.tasks.length, total: j.total };`);
      launch.firstListAfterLaunchMs = round(first.ms);
      entry.launch = launch;
      await sleep(1500);
      state = await inst.state();
      entry.memoryIdle = memory(state, webBefore);
      client = backendClient(state);
      log(`  launch: ${JSON.stringify(launch)}`);

      const ids = [];
      ids.projectIds = projectIds;
      const firstPage = await client.call('GET', '/api/tasks?limit=200');
      for (const t of firstPage.body.tasks) ids.push(t._id);
      entry.actualTasksBefore = firstPage.body.total;

      log('  backend latencies');
      entry.backend = await backendLatencies(client, ids, entry.actualTasksBefore);
      log('  page latencies (through the bridge)');
      entry.page = await pageLatencies(inst, ids);
      await sleep(1000);
      state = await inst.state();
      entry.memoryAfterLoad = memory(state, webBefore);
      entry.actualTasksAfter = (await client.call('GET', '/api/tasks?limit=1')).body.total;
      seedCounter = Math.max(seedCounter, entry.actualTasksAfter);
      log(`  ${JSON.stringify({ list: entry.backend.list, pageList: entry.page.list, mem: entry.memoryAfterLoad.totalMB })}`);

      const q0 = Date.now();
      const exit = await inst.quit();
      entry.quitMs = Date.now() - q0;
      entry.quitExitCode = exit.code;

      // Relaunch after ordinary use (the store now holds the commits of the samples above,
      // written one at a time, not a bulk import).
      if (size < SINGLE_LAUNCH_FROM) {
        inst = new Instance(app, dataDir, path.join(WORK, `ctl-re-${size}`));
        inst.start();
        entry.relaunchAfterUse = await launchTimes(inst, inst.spawnedAt);
        await inst.quit();
      }
    } catch (e) {
      entry.error = String(e && e.stack ? e.stack : e);
      log(`  FAILED at ${size}: ${entry.error}`);
      result.bySize[size] = entry;
      await inst.quit().catch(() => inst.kill9());
      break;
    }
    result.bySize[size] = entry;
    writeFileSync(path.join(WORK, 'partial.json'), JSON.stringify(result, null, 1));
  }
  result.leftoverHelpers = helperPids(app).length;
  result.finishedAt = new Date().toISOString();

  mkdirSync(path.join(ROOT, 'docs/perf'), { recursive: true });
  writeFileSync(path.join(ROOT, 'docs/perf/phase1.json'), JSON.stringify(result, null, 1) + '\n');
  writeFileSync(path.join(ROOT, 'docs/perf/phase1.md'), render(result));
  log('wrote docs/perf/phase1.md');
  rmSync(WORK, { recursive: true, force: true });
}

const fmt = (s) => (s ? `${s.p50} / ${s.p95}` : 'n/a');
function render(r) {
  const m = r.machine;
  const sizes = Object.keys(r.bySize);
  const col = (f) => sizes.map((s) => f(r.bySize[s]));
  const row = (label, f) => `| ${label} | ${col(f).map((v) => v ?? 'n/a').join(' | ')} |`;
  const head = `| | ${sizes.map((s) => `${Number(s).toLocaleString('en-US')} tasks`).join(' | ')} |\n|---|${sizes.map(() => '---').join('|')}|`;
  const cold = r.coldStart;
  const stat = (k) => {
    const v = cold.map((c) => c[k]).filter((x) => x != null);
    return v.length ? `${round(pct(v, 50))} (min ${round(Math.min(...v))}, max ${round(Math.max(...v))})` : 'n/a';
  };
  const mem = (k) => `${round(pct(cold.map((c) => c.memoryIdle[k]), 50))}`;
  return `# Phase 1 performance: Mac app, single device, offline

Measured by \`e2e/macos/perf.mjs\` on ${r.startedAt.slice(0, 10)}. Raw numbers: \`docs/perf/phase1.json\`.
Nothing here is estimated; a cell reads \`n/a\` when it was not measured, and a failure is recorded where it happened.

## Machine and build

- ${m.model}, ${m.chip}, ${m.cores} cores, ${m.memoryGB} GB RAM, macOS ${m.macos}
- App: release build with the E2E control folder compiled in (\`E2E=1 scripts/build-macos.sh\`); bundle ${r.appSizeMB} MB
- Helpers in the bundle:
\`\`\`
${r.versions.trim()}
\`\`\`
- The machine was in normal use during the run (other applications and a kdb development checkout were running), so treat absolute numbers as indicative and the shape across sizes as the finding.

## Method

- **Cold start** = a fresh data folder (identity, secrets and the store are created during the launch), ${cold.length} runs, each in its own folder. Not an OS-cold start: the files of a previous run are in the page cache, and \`purge\` needs root. Times are from the harness's \`spawn()\` to the event.
- **First contentful paint** is the web view's \`first-contentful-paint\` entry converted to wall-clock time. **Shell on screen** is the client's header present in the DOM. The page's first requests wait for the backend, so web view start-up and backend start-up overlap.
- **API latency** is per request, in milliseconds, **p50 / p95**, over 100 list, 100 create, 100 update, 60 search and 50 project-list requests (40/30/30/30/20 from 20,000 tasks on, where each request takes long enough that the run would otherwise take hours; the sample counts are in the table), issued one at a time, at each store size. Two layers:
  - *backend*: the harness talks straight to the local server's loopback port with the device token (Node + KDB only);
  - *page*: the same requests issued by \`fetch()\` in the web view, through the bridge to native code to the server (what the UI pays).
- **List** is \`GET /api/tasks?limit=200\` (the client's page size); **deep page** is the same with an offset of half the store. **Search** alternates three queries (a word in 1% of tasks, a common word, a two-word query). **Create** and **update** write one task per request, acknowledged after the store's fsync.
- Store sizes are reached with the app stopped: kdb-service is started on the data folder and tasks are written through the data layer (\`e2e/macos/seed.mts\`, the same schema normalisation as the API, spread over 20 projects, no activity-log entries), on one store that grows from size to size. Creating them over HTTP was tried first and abandoned: it seeded 500 tasks at 34 per second, and a run that then tried to add 1,500 more had not finished after eight minutes, with kdb-service near 140% CPU, because the store reads the whole collection for many writes. The latency samples add and edit a few hundred tasks, so the true count is shown.
- **Memory** is resident set size from \`ps\`: the app, the Node child and the kdb-service child, plus the WebKit processes that appeared while the app ran (WebContent, Networking, GPU; attributed by "not present before launch", so another application starting a web view during the run would be counted). RSS double counts shared pages.

## Cold start (fresh data folder, median of ${cold.length}, ms)

| Metric | Median (min, max) |
|---|---|
| spawn to window shown | ${stat('spawnToWindowMs')} |
| spawn to first contentful paint | ${stat('spawnToFirstContentfulPaintMs')} |
| spawn to shell on screen | ${stat('spawnToShellOnScreenMs')} |
| spawn to backend ready (store + Node) | ${stat('spawnToBackendReadyMs')} |
| kdb-service start (spawn to listening) | ${stat('kdbStartMs')} |
| Node start (spawn to ready) | ${stat('nodeStartMs')} |

Idle memory after a cold start (median, MB): app ${mem('appMB')}, Node ${mem('nodeMB')}, kdb-service ${mem('kdbMB')}, WebKit ${mem('webKitMB')}; **total ${mem('totalMB')}** (${mem('totalWithoutWebKitMB')} without WebKit).

## API latency by store size (p50 / p95 ms)

${head}
${row('actual tasks at start of sampling', (e) => e.actualTasksBefore)}
${row('samples per op (list / create / update / search)', (e) => e.samples && `${e.samples.list} / ${e.samples.create} / ${e.samples.update} / ${e.samples.search}`)}
${row('seeding rate (tasks/s, through the data layer)', (e) => e.seed && e.seed.perSecond)}
${row('**backend** list (200)', (e) => fmt(e.backend && e.backend.list))}
${row('backend list, deep page', (e) => fmt(e.backend && e.backend.listDeepPage))}
${row('backend project list', (e) => fmt(e.backend && e.backend.projects))}
${row('backend create', (e) => fmt(e.backend && e.backend.create))}
${row('backend update', (e) => fmt(e.backend && e.backend.update))}
${row('backend search', (e) => fmt(e.backend && e.backend.search))}
${row('**page** list (200)', (e) => fmt(e.page && e.page.list))}
${row('page project list', (e) => fmt(e.page && e.page.projects))}
${row('page create', (e) => fmt(e.page && e.page.create))}
${row('page update', (e) => fmt(e.page && e.page.update))}
${row('page search', (e) => fmt(e.page && e.page.search))}

## Memory by store size (MB, RSS)

${head}
${row('app, after the load', (e) => e.memoryAfterLoad && e.memoryAfterLoad.appMB)}
${row('Node, after the load', (e) => e.memoryAfterLoad && e.memoryAfterLoad.nodeMB)}
${row('kdb-service, after the load', (e) => e.memoryAfterLoad && e.memoryAfterLoad.kdbMB)}
${row('WebKit, after the load', (e) => e.memoryAfterLoad && e.memoryAfterLoad.webKitMB)}
${row('**total, after the load**', (e) => e.memoryAfterLoad && e.memoryAfterLoad.totalMB)}
${row('total, idle just after launch', (e) => e.memoryIdle && e.memoryIdle.totalMB)}
${row('Node, idle just after launch', (e) => e.memoryIdle && e.memoryIdle.nodeMB)}
${row('kdb-service, idle just after launch', (e) => e.memoryIdle && e.memoryIdle.kdbMB)}
${row('store on disk (MB)', (e) => e.storeOnDiskMB)}

## Launch on an existing store, and quit, by store size (ms)

${head}
${row('quit (menu quit to process exit)', (e) => e.quitMs)}
${row('first launch after the import: spawn to shell on screen', (e) => e.launchAfterImport && e.launchAfterImport.spawnToShellOnScreenMs)}
${row('relaunch after the sampling (ordinary use): spawn to shell on screen', (e) => e.relaunchAfterUse && e.relaunchAfterUse.spawnToShellOnScreenMs)}
${row('launch: spawn to window shown', (e) => e.launch && e.launch.spawnToWindowMs)}
${row('launch: spawn to backend ready', (e) => e.launch && e.launch.spawnToBackendReadyMs)}
${row('launch: spawn to first contentful paint', (e) => e.launch && e.launch.spawnToFirstContentfulPaintMs)}
${row('launch: spawn to shell on screen', (e) => e.launch && e.launch.spawnToShellOnScreenMs)}
${row('first task page (200), asked right after that', (e) => e.launch && e.launch.firstListAfterLaunchMs)}

${sizes.some((s) => r.bySize[s].error) ? '## Failures\n\n' + sizes.filter((s) => r.bySize[s].error).map((s) => `- ${s} tasks: ${r.bySize[s].error.split('\n')[0]}`).join('\n') + '\n' : ''}

## Limits found while measuring (manual runs outside this script; the numbers are as observed)

The requested sizes of 10,000 and 50,000 tasks could not be measured, because the KDB store the
app ships with does not hold them correctly. This is why the table stops at ${sizes[sizes.length - 1]} tasks.

1. **Documents beyond 10,000 per store are invisible, silently.** kdb-service v0.6.2 (the build in the
   app) caps a non-indexed scan at its first 10,000 documents *before* applying the \`WHERE\`, with no error
   (this is the defect described in \`kdb/docs/kdb-scan-cap-plan.md\`, fixed on kdb's
   \`fix/scan-cap-before-filter\`, not in the binary used here). One namespace holds every collection, so
   tasks, projects, activity entries and users share the 10,000. Observed in the app: 10,000 tasks
   imported, then \`GET /api/tasks\` reported \`total: 9998\` (the other two slots were the user and the
   default project), and a task created afterwards was written but could not be read back
   (\`GET\`/\`PATCH\` of it answered 404, 40 of 40 times). At 2,000, 4,000, 6,000 and 8,000 imported tasks the
   same create-then-update check passed 40 of 40. The newer kdb behaviour turns the silent truncation into a
   \`RESOURCE_EXHAUSTED\` error on any result over 10,000 rows, which would fail every list instead.
   Either way the store's design (every query reads the whole collection and filters in Node, see the comment
   at the top of \`src/data/kdb/store.ts\`) cannot go past 10,000 documents; it needs the SQL pushdown that
   file calls \`DATA_KDB_PUSHDOWN\`, or another store.
2. **Reopening a store costs time quadratic in its size.** Measured against a bare kdb-service (no qtask code),
   one task per commit, seeded and then restarted with a clean SIGTERM: the first full read after the restart took
   0.95 s at 1,000 documents, 3.6 s at 2,000, 8.0 s at 3,000 and 53 s at 8,000 (later reads: milliseconds). In
   the app, the launch on a 10,000-task store took 117 s before the UI appeared (the page's first requests wait for
   that read), and the kdb client's default 30 s deadline made those first requests fail until the app raised it
   (\`KDB_REQUEST_TIMEOUT_MS\`, set by \`src/local/entry.ts\`). The \`--maintenance-interval 5s\` flag did not
   change the 3,000-document result. Extrapolating this to 50,000 would be a guess, so none is given.
3. Both are in KDB, which this work does not modify; they are reported to its owner with the recipe above
   (\`SELECT\` after a restart; 12,000 upserts for the cap).

${sizes.some((s) => r.bySize[s].launchIsFirstAfterImport) ? 'At the largest size only one launch was measured (opening the store takes tens of minutes), so its "launch" rows are the first launch after the bulk import, not a steady-state launch.\n\n' : ''}Helper processes left running after the final quit: ${r.leftoverHelpers}.
`;
}

main().catch((e) => {
  console.error(e);
  console.log(`kept ${WORK}`);
  process.exit(1);
});
