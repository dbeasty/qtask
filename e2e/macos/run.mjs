#!/usr/bin/env node
// End-to-end tests for the Mac app (client-macos), driving the real built app.
//
//   E2E=1 scripts/build-macos.sh     # first: builds client-macos/build/QTask.app with the control folder
//   node e2e/macos/run.mjs           # then this; exits non-zero on any failure
//
// The app is steered through its control folder (QTASK_E2E_CONTROL; see
// client-macos/Sources/QTask/E2EControl.swift): no port, no automation permission. It runs
// under its own bundle id (com.qtask.mac.e2e) and its own data directory, so a test run never
// touches a real install's data or web storage.
//
// Environment:
//   QTASK_E2E_MACOS_APP   the .app to test (default client-macos/build/QTask.app)
//   QTASK_E2E_KEEP=1      keep the work folder (data, logs) even on success
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Instance, backendClient, helperPids, makeWork, prepareApp, sleep } from './lib.mjs';

const WORK = makeWork('qtask-macos-e2e-');
const results = [];
let failures = 0;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failures++;
    results.push({ name, ok: false, error: String(e && e.stack ? e.stack : e) });
    console.log(`  FAIL ${name}\n       ${String(e && e.message ? e.message : e).split('\n').join('\n       ')}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// The client's own call path: fetch from the page, which the bridge forwards natively.
const PAGE_API = `
const tok = localStorage.getItem('qtask_token');
const api = async (method, path, body) => {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
`;

async function main() {
  const app = prepareApp(WORK);
  const dataDir = path.join(WORK, 'data');
  const inst = new Instance(app, dataDir, path.join(WORK, 'ctl'));
  console.log(`work folder: ${WORK}`);

  let state;
  let projectId;
  let taskId;
  let secondTaskId;
  let extraProjectId;

  console.log('first launch (empty data folder)');
  await step('starts, shows the UI with no sign-in, and hides online-only UI', async () => {
    inst.start();
    await inst.waitForUi();
    state = await inst.state();
    assert(state.port > 0 && state.kdbPort > 0, 'backend and store ports reported');
    const ui = await inst.js(`
      const btn = (t) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith(t));
      return {
        mode: await (await fetch('/api/version')).json(),
        agent: btn('Agent'), projects: btn('Projects'), tasks: btn('Tasks'),
        bell: !!document.querySelector('.notification-bell, [aria-label*="otification"]'),
        login: /sign in|log in/i.test(document.body.innerText),
        tagline: document.querySelector('.header-tagline')?.textContent,
      };`);
    eq(ui.mode.mode, 'local', '/api/version mode');
    assert(ui.projects && ui.tasks, 'Projects and Tasks views present');
    assert(!ui.agent, 'Agent view must be hidden');
    assert(!ui.bell, 'notification bell must be hidden');
    assert(!ui.login, 'no sign-in UI');
    assert(/Offline/.test(ui.tagline || ''), 'local tagline');
  });

  await step('the user menu has no sign-out, password, MCP or feedback entries', async () => {
    await inst.js(`document.querySelector('.user-menu-trigger').click(); await new Promise(r => setTimeout(r, 200));`);
    const items = await inst.js(`return [...document.querySelectorAll('.user-menu-item')].map(e => e.textContent.trim())`);
    for (const bad of ['Sign out', 'Change password', 'External AI (MCP)', 'Send feedback', 'Take a tour']) {
      assert(!items.includes(bad), `"${bad}" must be hidden, menu: ${items.join(' | ')}`);
    }
    await inst.js(`document.querySelector('.user-menu-trigger').click(); return 1`);
  });

  console.log('projects and tasks');
  await step('creates a project and a task', async () => {
    const r = await inst.js(`${PAGE_API}
      const projects = await api('GET', '/api/projects');
      const project = projects.body.projects.find((p) => p.name === 'Project One');
      const t1 = await api('POST', '/api/tasks', { title: 'Buy oat milk', projectId: project._id });
      const t2 = await api('POST', '/api/tasks', { title: 'Write the quarterly report', projectId: project._id, priority: 'high' });
      const p2 = await api('POST', '/api/projects', { name: 'Garden' });
      return { project: project._id, t1: t1, t2: t2, p2: p2 };`);
    eq(r.t1.status, 201, 'create task status');
    eq(r.p2.status, 201, 'create project status');
    projectId = r.project;
    taskId = r.t1.body.task._id;
    secondTaskId = r.t2.body.task._id;
    extraProjectId = r.p2.body.project._id;
  });

  await step('the created task appears in the UI (after View > Reload, as the data changed behind the page)', async () => {
    await inst.native('menu Reload');
    await sleep(500);
    await inst.waitForUi();
    await inst.js(`[...document.querySelectorAll('.header-views-nav button')].find(b => b.textContent.trim() === 'Tasks').click(); return 1`);
    const deadline = Date.now() + 15000;
    for (;;) {
      const text = await inst.js(`return document.body.innerText`);
      if (text.includes('Buy oat milk')) break;
      if (Date.now() > deadline) throw new Error('task title never rendered; page text: ' + text.replace(/\s+/g, ' ').slice(0, 600));
      await sleep(100);
    }
  });

  await step('edits a task and a project', async () => {
    const r = await inst.js(`${PAGE_API}
      const t = await api('PATCH', '/api/tasks/${taskId}', { title: 'Buy oat milk and bread', description: 'from the corner shop' });
      const p = await api('PATCH', '/api/projects/${extraProjectId}', { name: 'Garden and balcony' });
      const got = await api('GET', '/api/tasks/${taskId}');
      return { t: t.status, p: p.status, title: got.body.task.title, description: got.body.task.description };`);
    eq(r.t, 200, 'patch task');
    eq(r.p, 200, 'patch project');
    eq(r.title, 'Buy oat milk and bread', 'title persisted in the response');
  });

  await step('completes a task', async () => {
    const r = await inst.js(`${PAGE_API}
      const t = await api('PATCH', '/api/tasks/${taskId}', { status: 'done' });
      return { s: t.status, status: t.body.task.status };`);
    eq(r.status, 'done', 'status');
  });

  await step('searches by title, description and project name', async () => {
    const r = await inst.js(`${PAGE_API}
      const a = await api('GET', '/api/search?q=' + encodeURIComponent('quarterly'));
      const b = await api('GET', '/api/search?q=' + encodeURIComponent('corner shop'));
      const c = await api('GET', '/api/search?q=' + encodeURIComponent('balcony'));
      return { a: JSON.stringify(a.body), b: JSON.stringify(b.body), c: JSON.stringify(c.body) };`);
    assert(r.a.includes('Write the quarterly report'), 'title search');
    assert(r.b.includes('Buy oat milk and bread'), 'description search');
    assert(r.c.includes('Garden and balcony'), 'project search');
  });

  await step('File > New Task opens the new-task form in the Tasks view', async () => {
    await inst.js(`[...document.querySelectorAll('.header-views-nav button')].find(b => b.textContent.trim() === 'Projects').click(); return 1`);
    await sleep(300);
    await inst.native('menu New Task');
    const deadline = Date.now() + 10000;
    for (;;) {
      const r = await inst.js(`return { active: document.querySelector('.header-views-nav .nav-active')?.textContent.trim(), form: !!document.querySelector('input[placeholder*="itle" i], input[name="title"], .task-form input') };`);
      if (r.active === 'Tasks' && r.form) break;
      if (Date.now() > deadline) throw new Error(`menu command had no effect: ${JSON.stringify(r)}`);
      await sleep(100);
    }
  });

  await step('the Dock badge counts open tasks due today', async () => {
    const r = await inst.js(`${PAGE_API}
      const now = new Date(); now.setHours(12, 0, 0, 0);
      const a = await api('POST', '/api/tasks', { title: 'Due today A', projectId: '${projectId}', dueDate: now.toISOString() });
      const b = await api('POST', '/api/tasks', { title: 'Due today B', projectId: '${projectId}', dueDate: now.toISOString() });
      return [a.status, b.status];`);
    eq(r, [201, 201], 'create due tasks');
    const deadline = Date.now() + 15000;
    let badge;
    for (;;) {
      badge = await inst.native('badge');
      if (badge === '2') break;
      if (Date.now() > deadline) throw new Error(`badge is ${JSON.stringify(badge)}, expected "2"`);
      await sleep(200);
    }
  });

  await step('deletes a task and a project', async () => {
    const r = await inst.js(`${PAGE_API}
      const d1 = await api('DELETE', '/api/tasks/${secondTaskId}');
      const d2 = await api('DELETE', '/api/projects/${extraProjectId}');
      const tasks = await api('GET', '/api/tasks?limit=200');
      const projects = await api('GET', '/api/projects');
      return { d1: d1.status, d2: d2.status, tasks: tasks.body.tasks.map(t => t.title), projects: projects.body.projects.map(p => p.name) };`);
    assert(r.d1 < 300 && r.d2 < 300, `delete statuses ${r.d1} ${r.d2}`);
    assert(!r.tasks.includes('Write the quarterly report'), 'task gone');
    assert(!r.projects.includes('Garden and balcony'), 'project gone');
    assert(r.tasks.includes('Buy oat milk and bread'), 'other task kept');
  });

  console.log('no network from the web view');
  await step('the web view cannot reach any address, including the local server', async () => {
    const r = await inst.js(`
      const port = ${state.port};
      const attempt = (fn) => Promise.race([fn().then(() => 'reached', (e) => 'blocked'), new Promise((r) => setTimeout(() => r('timeout'), 4000))]);
      const out = {};
      out.fetchExternal = await attempt(() => fetch('https://example.com/'));
      out.fetchExternalNoCors = await attempt(() => fetch('https://example.com/', { mode: 'no-cors' }));
      out.fetchLoopbackBackend = await attempt(() => fetch('http://127.0.0.1:' + port + '/health'));
      out.fetchLoopbackWithAbs = await attempt(() => fetch('http://localhost:' + port + '/api/version'));
      out.xhr = await attempt(() => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', 'https://example.com/'); x.onload = res; x.onerror = rej; x.send(); }));
      out.xhrBackend = await attempt(() => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', 'http://127.0.0.1:' + port + '/health'); x.onload = res; x.onerror = rej; x.send(); }));
      out.websocket = await attempt(() => new Promise((res, rej) => { const w = new WebSocket('ws://127.0.0.1:' + port + '/'); w.onopen = res; w.onerror = rej; w.onclose = rej; }));
      out.eventsource = await attempt(() => new Promise((res, rej) => { const e = new EventSource('https://example.com/'); e.onopen = res; e.onerror = rej; }));
      out.image = await attempt(() => new Promise((res, rej) => { const i = new Image(); i.onload = res; i.onerror = rej; i.src = 'https://example.com/favicon.ico?x=' + Date.now(); }));
      out.script = await attempt(() => new Promise((res, rej) => { const s = document.createElement('script'); s.onload = res; s.onerror = rej; s.src = 'https://example.com/x.js'; document.head.appendChild(s); }));
      // sendBeacon reports "queued" whatever happens to the request; what matters is that
      // the engine's policy refused it, which shows up as a violation for its address.
      const before = (window.__qtaskCsp || []).length;
      try { navigator.sendBeacon('https://example.org/beacon', 'x'); } catch (e) {}
      await new Promise((r) => setTimeout(r, 500));
      out.beacon = (window.__qtaskCsp || []).slice(before).some((v) => v.uri.includes('example.org/beacon')) ? 'blocked' : 'not refused by the policy';
      // A frame that is refused still fires "load" (on an empty document); the policy violation is the evidence.
      { const before = (window.__qtaskCsp || []).length; const f = document.createElement('iframe'); f.src = 'https://example.net/frame'; document.body.appendChild(f); await new Promise((r) => setTimeout(r, 800));
        out.iframe = (window.__qtaskCsp || []).slice(before).some((v) => v.uri.includes('example.net')) ? 'blocked' : 'not refused by the policy'; }
      // The bridge itself: hand-made messages for anything but the app's API are refused.
      const post = (m) => window.webkit.messageHandlers.qtask.postMessage(m);
      out.bridgeEtc = await attempt(() => post({ op: 'fetch', method: 'GET', path: '/etc/passwd', headers: {} }));
      out.bridgeAbs = await attempt(() => post({ op: 'fetch', method: 'GET', path: 'http://example.com/api/x', headers: {} }));
      out.bridgeAuthority = await attempt(() => post({ op: 'fetch', method: 'GET', path: '//example.com/api/x', headers: {} }));
      out.bridgeDot = await attempt(() => post({ op: 'fetch', method: 'GET', path: '/api/../health', headers: {} }));
      out.bridgeMethod = await attempt(() => post({ op: 'fetch', method: 'CONNECT', path: '/api/tasks', headers: {} }));
      out.bridgeUnknownOp = await attempt(() => post({ op: 'open', url: 'https://example.com' }));
      out.csp = (window.__qtaskCsp || []).map((v) => v.directive + ' ' + v.uri);
      return out;`);
    for (const [k, v] of Object.entries(r)) {
      if (k === 'csp') continue;
      assert(v === 'blocked', `${k} was "${v}", expected "blocked"`);
    }
    assert(r.csp.some((c) => c.startsWith('connect-src')), `no connect-src violation recorded: ${JSON.stringify(r.csp)}`);
    const s = await inst.state();
    assert(s.bridgeRefused >= 6, `the bridge should have refused the hand-made requests, refused ${s.bridgeRefused}`);
  });

  await step('only loopback sockets are open, and only for the two children', async () => {
    const s = await inst.state();
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', [s.appPid, s.nodePid, s.kdbPid].join(',')], { encoding: 'utf8' });
    const lines = out.split('\n').slice(1).filter(Boolean);
    assert(lines.length >= 2, `expected the two children listening, got:\n${out}`);
    for (const l of lines) {
      assert(/127\.0\.0\.1:\d+ \(LISTEN\)/.test(l), `non-loopback listener: ${l}`);
      assert(!l.startsWith('QTask '), `the app itself must not listen: ${l}`);
    }
    const ports = lines.map((l) => Number(l.match(/127\.0\.0\.1:(\d+)/)[1])).sort();
    eq(ports, [s.kdbPort, s.port].sort(), 'listening ports');
  });

  await step('the local server refuses requests without this launch\'s device token', async () => {
    const s = await inst.state();
    const none = await fetch(`http://127.0.0.1:${s.port}/api/version`);
    eq(none.status, 403, 'no token');
    const wrong = await fetch(`http://127.0.0.1:${s.port}/api/version`, { headers: { 'x-qtask-device-token': 'x'.repeat(64) } });
    eq(wrong.status, 403, 'wrong token');
    const ok = await fetch(`http://127.0.0.1:${s.port}/api/version`, { headers: { 'x-qtask-device-token': s.deviceToken } });
    eq((await ok.json()).mode, 'local', 'right token');
    const gone = await fetch(`http://127.0.0.1:${s.port}/api/auth/login`, { method: 'POST', headers: { 'x-qtask-device-token': s.deviceToken } });
    eq(gone.status, 404, 'sign-in is not mounted');
  });

  console.log('relaunch');
  let firstDeviceId;
  await step('quits cleanly: both children exit and the app exits 0', async () => {
    firstDeviceId = (await inst.state()).deviceId;
    const exit = await inst.quit();
    eq(exit.code, 0, 'exit code');
    await sleep(300);
    eq(helperPids(app), [], 'leftover helper processes');
  });

  await step('relaunches with the data intact', async () => {
    inst.start();
    await inst.waitForUi();
    const s = await inst.state();
    eq(s.deviceId, firstDeviceId, 'same device identity across launches');
    const r = await inst.js(`${PAGE_API}
      const tasks = await api('GET', '/api/tasks?limit=200');
      const projects = await api('GET', '/api/projects');
      const titles = tasks.body.tasks.map(t => t.title).sort();
      const done = tasks.body.tasks.find(t => t.title === 'Buy oat milk and bread');
      return { titles, done: done && done.status, desc: done && done.description, projects: projects.body.projects.map(p => p.name).sort() };`);
    eq(r.titles, ['Buy oat milk and bread', 'Due today A', 'Due today B'], 'tasks after relaunch');
    eq(r.done, 'done', 'completed status persisted');
    eq(r.desc, 'from the corner shop', 'edit persisted');
    eq(r.projects, ['Project One'], 'projects after relaunch');
    const search = await inst.js(`${PAGE_API} return JSON.stringify((await api('GET', '/api/search?q=oat')).body)`);
    assert(search.includes('Buy oat milk and bread'), 'search works after relaunch');
  });

  await step('a force-killed app leaves no unusable state: relaunch ends the stale children and keeps the data', async () => {
    const before = await inst.state();
    await inst.js(`${PAGE_API} return (await api('POST', '/api/tasks', { title: 'Written just before the crash', projectId: (await api('GET', '/api/projects')).body.projects.find((p) => p.name === 'Project One')._id })).status`);
    await inst.kill9();
    await sleep(500);
    // node notices its stdin closed and goes; kdb-service stays until the next launch ends it.
    inst.start();
    await inst.waitForUi();
    const after = await inst.state();
    assert(after.kdbPid !== before.kdbPid, 'a new store process');
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert(!alive(before.kdbPid), 'the orphaned store was ended');
    assert(!alive(before.nodePid), 'the orphaned backend was ended');
    const titles = await inst.js(`${PAGE_API} return (await api('GET', '/api/tasks?limit=200')).body.tasks.map(t => t.title)`);
    assert(titles.includes('Written just before the crash'), 'the last acknowledged write survived the crash');
  });

  await step('a second copy on the same data folder refuses to start instead of opening the store twice', async () => {
    const second = new Instance(app, dataDir, path.join(WORK, 'ctl2'));
    second.start();
    await sleep(6000);
    const txt = await second.js(`return document.body.innerText`).catch(() => '');
    // The page cannot get a backend; the window shows the failure.
    const s = await second.state();
    assert(!s.port, 'the second copy must not have a backend of its own');
    void txt;
    await second.kill9();
  });

  await step('final quit is clean', async () => {
    const exit = await inst.quit();
    eq(exit.code, 0, 'exit code');
    await sleep(300);
    eq(helperPids(app), [], 'leftover helper processes');
  });

  // The device files are private.
  await step('the data folder is owner-only and holds the device key privately', async () => {
    const mode = (p) => (parseInt(execFileSync('stat', ['-f', '%Lp', p], { encoding: 'utf8' }).trim(), 8) & 0o077);
    eq(mode(dataDir), 0, 'data dir');
    eq(mode(path.join(dataDir, 'device.key')), 0, 'device.key');
    eq(mode(path.join(dataDir, 'secrets.json')), 0, 'secrets.json');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length;
}

main()
  .then((n) => {
    if (n === 0 && process.env.QTASK_E2E_KEEP !== '1') rmSync(WORK, { recursive: true, force: true });
    else console.log(`kept ${WORK}`);
    process.exit(n === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    console.log(`kept ${WORK}`);
    process.exit(2);
  });
