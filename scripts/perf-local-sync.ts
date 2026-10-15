/**
 * Measurements for device sync in local mode (docs/perf/local-sync.md). Two real
 * local-mode backends (separate processes, own kdb-service each) on this Mac, paired over
 * the Wi-Fi transport on loopback.
 *
 *   npx tsx scripts/perf-local-sync.ts            # JSON on stdout
 *   SAMPLES=50 SEED=2000 IDLE_S=60 npx tsx scripts/perf-local-sync.ts
 *
 * 1. write -> visible: a REST write on A, then B polled over REST every 5 ms until it has it.
 * 2. no-op sync cycle: POST /api/local-sync/now with nothing to send (HTTP included), at the
 *    initial size and after seeding SEED tasks.
 * 3. idle CPU of the backend processes (node + kdb-service) over IDLE_S seconds: paired and
 *    connected, vs a backend started with QTASK_LOCAL_SYNC=0.
 */

import { execFileSync } from 'node:child_process';
import { LocalDevice, freePort, pairDevices, sleep } from '../tests/helpers/local-device.ts';

const SAMPLES = Number(process.env.SAMPLES ?? 40);
const SEED = Number(process.env.SEED ?? 2000);
const IDLE_S = Number(process.env.IDLE_S ?? 60);
/** Quiet time between latency samples, so each write starts from an idle device (no round already scheduled). */
const GAP_MS = Number(process.env.GAP_MS ?? 1500);

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
}
const summary = (v: number[]) => ({ n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: pct(v, 100) });

/** CPU seconds (user+sys) of a pid, from ps. */
function cpuSeconds(pid: number): number {
  const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const parts = t.split(':').map(Number);
  return parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : parts[0]! * 60 + parts[1]!;
}

async function idleCpu(devices: LocalDevice[], seconds: number): Promise<number> {
  const pids = devices.flatMap((d) => [d.node!.pid!, d.kdb!.pid!]);
  const before = pids.map(cpuSeconds);
  await sleep(seconds * 1000);
  const after = pids.map(cpuSeconds);
  const used = after.reduce((s, v, i) => s + v - before[i]!, 0);
  return Math.round((used / seconds / devices.length) * 100 * 100) / 100; // % of one core, per device
}

async function visibleLatency(from: LocalDevice, to: LocalDevice, n: number, label: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await from.api('POST', '/api/tasks', { title: `${label} ${i}` });
    if (r.status !== 201) throw new Error(`create ${r.status}`);
    const id = r.body.task._id;
    for (;;) {
      if ((await to.api('GET', `/api/tasks/${id}`)).status === 200) break;
      if (performance.now() - t0 > 30_000) throw new Error('never arrived');
      await sleep(5);
    }
    out.push(performance.now() - t0);
    await sleep(GAP_MS); // let rounds (and their follow-up writes) settle so samples are independent
  }
  return out;
}

async function noopCycles(d: LocalDevice, n: number): Promise<number[]> {
  const out: number[] = [];
  await d.sync('POST', '/now');
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await d.sync('POST', '/now');
    out.push(performance.now() - t0);
  }
  return out;
}

async function main() {
  const result: Record<string, unknown> = { samples: SAMPLES, seed: SEED, idleSeconds: IDLE_S, gapMs: GAP_MS, node: process.version, at: new Date().toISOString() };
  const mdnsPort = await freePort();
  const a = new LocalDevice({ name: 'Perf A', mdnsPort });
  const b = new LocalDevice({ name: 'Perf B', mdnsPort });
  try {
    await Promise.all([a.start(), b.start()]);
    await pairDevices(a, b);
    await sleep(1000);

    result.writeToVisibleAtoB = summary(await visibleLatency(a, b, SAMPLES, 'A to B'));
    result.writeToVisibleBtoA = summary(await visibleLatency(b, a, SAMPLES, 'B to A'));
    result.noopSyncSmall = { documents: (await a.status()).documents, ...summary(await noopCycles(a, SAMPLES)) };

    // Seed SEED tasks on A (through REST), wait for B to have them all.
    const t0 = performance.now();
    for (let i = 0; i < SEED; i += 50) {
      await Promise.all(Array.from({ length: Math.min(50, SEED - i) }, (_, j) => a.api('POST', '/api/tasks', { title: `seed ${i + j}` })));
    }
    const seededAt = performance.now();
    for (;;) {
      const r = await b.api('GET', '/api/tasks?limit=1');
      if (r.body.total >= SEED) break;
      if (performance.now() - seededAt > 600_000) throw new Error('seed never converged');
      await sleep(100);
    }
    result.seed = { tasks: SEED, writeMs: Math.round(seededAt - t0), convergedAfterLastWriteMs: Math.round(performance.now() - seededAt) };
    await sleep(2000);
    result.noopSyncSeeded = { documents: (await a.status()).documents, ...summary(await noopCycles(a, SAMPLES)) };
    result.writeToVisibleSeeded = summary(await visibleLatency(a, b, Math.min(SAMPLES, 20), 'seeded A to B'));

    await sleep(3000);
    result.idleCpuPairedPctPerDevice = await idleCpu([a, b], IDLE_S);
  } finally {
    await Promise.allSettled([a.stop(), b.stop()]);
  }

  const off = new LocalDevice({ name: 'Perf off', env: { QTASK_LOCAL_SYNC: '0' } });
  const lone = new LocalDevice({ name: 'Perf lone', mdnsPort });
  try {
    await Promise.all([off.start(), lone.start()]);
    await sleep(3000);
    const [cpuOff, cpuLone] = await Promise.all([idleCpu([off], IDLE_S), idleCpu([lone], IDLE_S)]);
    result.idleCpuSyncOffPct = cpuOff;
    result.idleCpuSyncOnUnpairedPct = cpuLone;
  } finally {
    await Promise.allSettled([off.stop(), lone.stop()]);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
