#!/usr/bin/env node
// Two copies of the built Mac app on this Mac, each with its own data folder and bundle id,
// paired through their UI (File > Pair Device…, then Join with the link on the other) and
// syncing over the Wi-Fi transport. Checks that a task written on one appears in the other's
// task list without a reload (the change signal), and the other way round.
//
//   E2E=1 scripts/build-macos.sh
//   node e2e/macos/sync.mjs                 # exits non-zero on any failure
//
// The two backends talk TLS to each other on the address the pairing link carries (this
// Mac's LAN address, or 127.0.0.1 with no network): the same machine, so loopback in effect.
// mDNS runs on the real port 5353, as the app always does.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Instance, backendClient, makeWork, prepareApp, sleep } from './lib.mjs';

/** CPU seconds (user+sys) of a pid, from ps. */
function cpuSeconds(pid) {
  try {
    const parts = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(':').map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  } catch {
    return 0;
  }
}

/** % of one core used by an app copy and its two children over `seconds` of idling. */
async function idleCpu(inst, seconds) {
  const s = await inst.state();
  const pids = [s.appPid, s.nodePid, s.kdbPid];
  const before = pids.map(cpuSeconds);
  await sleep(seconds * 1000);
  const after = pids.map(cpuSeconds);
  const per = pids.map((_, i) => Math.round(((after[i] - before[i]) / seconds) * 10000) / 100);
  return { totalPct: Math.round(per.reduce((a, b) => a + b, 0) * 100) / 100, appPct: per[0], nodePct: per[1], kdbPct: per[2] };
}

const IDLE_S = Number(process.env.QTASK_E2E_IDLE_SECONDS ?? 0);

const WORK = makeWork('qtask-macos-sync-');
let failures = 0;
const timings = {};

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String(e && e.message ? e.message : e).split('\n').join('\n       ')}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function until(what, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out: ${what}${last ? ` (${last.message})` : ''}`);
    await sleep(100);
  }
}

const PAGE_API = `
const tok = localStorage.getItem('qtask_token');
const api = async (method, path, body) => {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
`;

const clickNav = (label) =>
  `[...document.querySelectorAll('.header-views-nav button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click(); return 1`;

async function main() {
  console.log(`work folder: ${WORK}`);
  const A = new Instance(prepareApp(path.join(WORK, 'a'), 'com.qtask.mac.e2e.a'), path.join(WORK, 'a', 'data'), path.join(WORK, 'a', 'ctl'));
  const B = new Instance(prepareApp(path.join(WORK, 'b'), 'com.qtask.mac.e2e.b'), path.join(WORK, 'b', 'data'), path.join(WORK, 'b', 'ctl'));

  await step('two copies start side by side', async () => {
    A.start({ env: { QTASK_DEVICE_NAME: 'E2E Mac A' } });
    B.start({ env: { QTASK_DEVICE_NAME: 'E2E Mac B' } });
    await Promise.all([A.waitForUi(), B.waitForUi()]);
    const [sa, sb] = await Promise.all([A.state(), B.state()]);
    assert(sa.port !== sb.port && sa.dataDir !== sb.dataDir, 'separate backends');
  });

  let link;
  await step('File > Pair Device… on A shows the Devices page with a QR code and a link', async () => {
    await A.native('menu Pair Device…');
    link = await until('the pairing link', () =>
      A.js(`const i = document.querySelector('.devices-link'); return i && i.value && document.querySelector('.devices-qr svg') ? i.value : null`)
    );
    assert(link.startsWith('qtask://pair?'), `link: ${link}`);
  });

  await step('View > Devices & Sync on B, paste the link, Join: both show the pairing', async () => {
    await B.native('menu Devices & Sync');
    await until('the join form on B', () => B.js(`return !!document.querySelector('.devices-join input')`));
    await B.js(`
      const input = document.querySelector('.devices-join input');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, ${JSON.stringify(link)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
      document.querySelector('.devices-join button[type=submit]').click();
      return 1`);
    await until('B says paired', () => B.js(`return document.body.innerText.includes('Paired with E2E Mac A')`), 30000);
    await until('A lists B as connected over Wi-Fi', () =>
      A.js(`return [...document.querySelectorAll('.devices-peer')].some(p => p.innerText.includes('E2E Mac B') && p.innerText.includes('Connected · Wi-Fi'))`)
    );
    await until('B lists A as connected over Wi-Fi', () =>
      B.js(`return [...document.querySelectorAll('.devices-peer')].some(p => p.innerText.includes('E2E Mac A') && p.innerText.includes('Connected · Wi-Fi'))`)
    );
    await A.native(`screenshot ${path.join(WORK, 'a-devices.png')}`).catch(() => undefined);
    await B.native(`screenshot ${path.join(WORK, 'b-devices.png')}`).catch(() => undefined);
  });

  await step('a task written on A appears in B\'s Tasks view without a reload', async () => {
    await B.js(clickNav('Tasks'));
    await sleep(500);
    const loadsBefore = (await B.state()).pageLoads;
    const t0 = Date.now();
    const r = await A.js(`${PAGE_API} return await api('POST', '/api/tasks', { title: 'Synced through two apps' });`);
    assert(r.status === 201, `create on A: ${JSON.stringify(r)}`);
    await until('the title in B\'s page', () => B.js(`return document.body.innerText.includes('Synced through two apps')`), 30000);
    timings.aToBVisibleMs = Date.now() - t0;
    assert((await B.state()).pageLoads === loadsBefore, 'B did not reload the page');
  });

  await step('an edit on B appears in A\'s Tasks view without a reload', async () => {
    await A.js(clickNav('Tasks'));
    await sleep(500);
    const id = await B.js(`${PAGE_API} const r = await api('GET', '/api/tasks'); return r.body.tasks.find(t => t.title === 'Synced through two apps')._id;`);
    const t0 = Date.now();
    const r = await B.js(`${PAGE_API} return await api('PATCH', '/api/tasks/${id}', { title: 'Edited on B' });`);
    assert(r.status === 200, `edit on B: ${JSON.stringify(r)}`);
    await until('the edit in A\'s page', () => A.js(`return document.body.innerText.includes('Edited on B')`), 30000);
    timings.bToAVisibleMs = Date.now() - t0;
  });

  await step('File > Sync Now and the status API agree nothing is pending', async () => {
    await A.native('menu Sync Now');
    const s = await backendClient(await A.state()).call('GET', '/api/local-sync/status');
    assert(s.status === 200, `status ${s.status}`);
    await until('nothing pending on A', async () => (await backendClient(await A.state()).call('GET', '/api/local-sync/status')).body.peers[0].pendingChanges === 0);
  });

  if (IDLE_S > 0) {
    await step(`idle CPU over ${IDLE_S} s, paired and connected (window visible, Tasks view)`, async () => {
      await sleep(3000);
      const [ia, ib] = await Promise.all([idleCpu(A, IDLE_S), idleCpu(B, IDLE_S)]);
      timings.idlePaired = { a: ia, b: ib };
    });
  }

  await step('both quit cleanly', async () => {
    const [ra, rb] = await Promise.all([A.quit(), B.quit()]);
    assert(ra.code === 0 && rb.code === 0, `exit codes ${ra.code} ${rb.code}`);
  });

  if (IDLE_S > 0) {
    await step(`idle CPU over ${IDLE_S} s with device sync off (QTASK_LOCAL_SYNC=0), same data`, async () => {
      A.start({ env: { QTASK_DEVICE_NAME: 'E2E Mac A', QTASK_LOCAL_SYNC: '0' } });
      await A.waitForUi();
      await A.js(clickNav('Tasks'));
      await sleep(3000);
      timings.idleSyncOff = await idleCpu(A, IDLE_S);
      await A.quit();
    });
  }

  console.log(JSON.stringify({ timings }));
  if (failures) {
    console.log(`${failures} step(s) failed; work folder kept: ${WORK}`);
    process.exit(1);
  }
  if (process.env.QTASK_E2E_KEEP === '1') console.log(`work folder kept: ${WORK}`);
  else rmSync(WORK, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
