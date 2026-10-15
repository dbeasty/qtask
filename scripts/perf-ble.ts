/**
 * Bluetooth sync measurements on the SIMULATED radio (virtual time). `npm run perf:ble`.
 *
 * What this measures: the protocol's behaviour (round trips, bytes, flow control,
 * reconnect logic) on a link with the stated MTU, throughput and latency. What it does not
 * measure: a real radio (throughput, loss, coexistence with Wi-Fi), several centrals
 * contending, iOS or Android stacks, backgrounding, or CPU/battery. Every time below is
 * VIRTUAL milliseconds of radio time; computation counts as zero. See docs/perf/phase4.md.
 *
 *   PROFILES=a,b,c   SIZES=1000,10000   QUICK=1   node --import tsx scripts/perf-ble.ts
 */

import { converged as _unused, makeBleDevice, pairAll, realisticTask, seedTasks, startDevice, stopAll, world, type BleDevice } from '../tests/helpers/ble-world.ts';
import type { SimParams, SimWorld } from '../src/sync/ble/sim.ts';
import { deflateRawSync } from 'node:zlib';

void _unused;

const PROFILES: Record<string, Partial<SimParams> & { label: string }> = {
  'mtu185-20KBps-100ms': { label: 'MTU 185, 20 KB/s, 100 ms', mtu: 185, bytesPerSec: 20_000, latencyMs: 100 },
  'mtu185-60KBps-50ms': { label: 'MTU 185, 60 KB/s, 50 ms', mtu: 185, bytesPerSec: 60_000, latencyMs: 50 },
  'mtu512-150KBps-30ms': { label: 'MTU 512, 150 KB/s, 30 ms', mtu: 512, bytesPerSec: 150_000, latencyMs: 30 },
};

const only = (process.env.PROFILES ?? '').split(',').filter(Boolean);
const SIZES = (process.env.SIZES ?? '1000,10000').split(',').map(Number);
const QUICK = process.env.QUICK === '1';

const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

interface Variant {
  headersFirst: boolean;
  deflate: boolean;
  batchSize?: number;
  singleInitiator?: boolean;
}

async function pairOfDevices(params: Partial<SimParams>, v: Variant, seed = 1) {
  const w = world(params, seed);
  const o = {
    headersFirst: v.headersFirst,
    batchSize: v.batchSize,
    singleInitiator: v.singleInitiator,
    deferStart: true,
    ble: { channel: v.deflate ? {} : { compressThreshold: Infinity } },
  };
  const a = await makeBleDevice(w, 'A', o);
  const b = await makeBleDevice(w, 'B', o);
  return { w, a, b };
}

function countPoller(w: SimWorld, d: BleDevice, everyMs = 25) {
  const state = { n: 0 };
  const tick = () => {
    void d.tasks().countDocuments({}).then((n) => (state.n = n));
    w.clock.schedule(w.clock.now() + everyMs, 'radio', tick);
  };
  tick();
  return state;
}

async function initialSync(params: Partial<SimParams>, n: number, v: Variant, hard = false) {
  const { w, a, b } = await pairOfDevices(params, v);
  const rawBytes = await seedTasks(a, n, 'task-', 0, hard);
  const bodies = Array.from({ length: Math.min(n, 2000) }, (_, i) => Buffer.from(JSON.stringify(realisticTask(i, 7, hard))));
  const sample = Buffer.concat(bodies);
  const deflatedRatio = deflateRawSync(sample).length / sample.length;
  const ups: number[] = [];
  a.transport.onPeerUp(() => ups.push(w.clock.now()));
  b.transport.onPeerUp(() => ups.push(w.clock.now()));
  await pairAll([a, b]);
  await startDevice(a);
  await startDevice(b);
  const cnt = countPoller(w, b);
  await w.until(() => cnt.n === n, { what: `${n} docs`, maxVirtualMs: 6 * 3_600_000 });
  const done = w.clock.now();
  const linkUp = Math.min(...ups);
  const air = w.airStats();
  const sa = a.ble.wireStats();
  const sb = b.ble.wireStats();
  const out = {
    docs: n,
    rawJsonKB: r1(rawBytes / 1024),
    deflateRatioOfDocs: r1(deflatedRatio * 100) / 100,
    connectMs: Math.round(linkUp),
    syncMs: Math.round(done - linkUp),
    airKB: r1(air.bytes / 1024),
    aToBFrameKB: r1(sb.frameBytesIn / 1024),
    bToAFrameKB: r1(sa.frameBytesIn / 1024),
    chunks: air.chunks,
    refusedWrites: air.refused,
    messages: sa.messagesOut + sb.messagesOut,
    creditStalls: sa.creditStalls + sb.creditStalls,
  };
  await stopAll();
  return out;
}

async function latency(params: Partial<SimParams>, v: Variant, n: number) {
  const { w, a, b } = await pairOfDevices(params, v);
  await seedTasks(a, n);
  await pairAll([a, b]);
  await startDevice(a);
  await startDevice(b);
  const cnt = countPoller(w, b, 20);
  await w.until(() => cnt.n === n, { what: 'initial', maxVirtualMs: 6 * 3_600_000 });
  await w.advance(3000);
  const samples: number[] = [];
  const before = w.airStats().bytes;
  const trials = QUICK ? 10 : 30;
  for (let i = 0; i < trials; i++) {
    const t0 = w.clock.now();
    await a.tasks().create({ _id: `lat-${i}`, userId: 'u1', title: `Call back about ${i}` });
    void a.coordinator.syncNow();
    await w.until(() => cnt.n === n + i + 1, { what: 'one change' });
    samples.push(w.clock.now() - t0);
    await w.advance(700);
  }
  const perChange = (w.airStats().bytes - before) / trials;
  // the other direction, initiated by the device that is not normally the initiator
  const back: number[] = [];
  const cntA = countPoller(w, a, 20);
  for (let i = 0; i < trials; i++) {
    const t0 = w.clock.now();
    await b.tasks().create({ _id: `latb-${i}`, userId: 'u1', title: `Reply ${i}` });
    void b.coordinator.syncNow();
    await w.until(() => cntA.n === n + trials + i + 1, { what: 'one change back' });
    back.push(w.clock.now() - t0);
    await w.advance(700);
  }
  await stopAll();
  return {
    docsOnDevice: n,
    aToB: { p50: Math.round(pct(samples, 0.5)), p95: Math.round(pct(samples, 0.95)), max: Math.round(Math.max(...samples)) },
    bToA: { p50: Math.round(pct(back, 0.5)), p95: Math.round(pct(back, 0.95)), max: Math.round(Math.max(...back)) },
    airBytesPerChange: Math.round(perChange),
  };
}

async function reconnect(params: Partial<SimParams>, v: Variant) {
  const { w, a, b } = await pairOfDevices(params, v);
  await seedTasks(a, 100);
  await pairAll([a, b]);
  await startDevice(a);
  await startDevice(b);
  const up = () => a.transport.links().length > 0 && b.transport.links().length > 0;
  const t0 = w.clock.now();
  await w.until(up, { what: 'first link' });
  const firstLinkMs = w.clock.now() - t0;
  const cnt = countPoller(w, b, 20);
  await w.until(() => cnt.n === 100, { what: 'sync' });
  await w.advance(5000);
  const trials = QUICK ? 4 : 10;
  const sameAddr: Array<{ link: number; synced: number }> = [];
  const rotated: Array<{ link: number; synced: number }> = [];
  let want = 100;
  for (const rotate of [false, true]) {
    for (let i = 0; i < trials; i++) {
      w.setRange(a.radio, b.radio, false);
      await w.until(() => !up() && a.transport.links().length === 0 && b.transport.links().length === 0, { what: 'loss detected', maxVirtualMs: 120_000 });
      if (rotate) w.rotateAddress(b.radio);
      await a.tasks().create({ _id: `gap-${rotate ? 'r' : 's'}-${i}`, userId: 'u1', title: 'made while apart' });
      want++;
      // Random time spent out of range (5-60 s) so the reconnect timers are not always at the same phase.
      await w.advance(5000 + Math.floor(w.rand() * 55_000));
      const back = w.clock.now();
      w.setRange(a.radio, b.radio, true);
      await w.until(up, { what: 'relink', maxVirtualMs: 600_000 });
      const linkMs = w.clock.now() - back;
      void a.coordinator.syncNow();
      await w.until(() => cnt.n === want, { what: 'resync', maxVirtualMs: 600_000 });
      (rotate ? rotated : sameAddr).push({ link: linkMs, synced: w.clock.now() - back });
      await w.advance(3000);
    }
  }
  const sum = (xs: Array<{ link: number; synced: number }>) => ({
    linkP50: Math.round(pct(xs.map((x) => x.link), 0.5)),
    linkP95: Math.round(pct(xs.map((x) => x.link), 0.95)),
    linkMax: Math.round(Math.max(...xs.map((x) => x.link))),
    syncedP50: Math.round(pct(xs.map((x) => x.synced), 0.5)),
    syncedMax: Math.round(Math.max(...xs.map((x) => x.synced))),
  });
  // idle cost: nothing changing for five minutes
  const air0 = w.airStats().bytes;
  await w.advance(300_000);
  const idleBytes = w.airStats().bytes - air0;
  await stopAll();
  return { firstLinkMs: Math.round(firstLinkMs), trials, sameAddress: sum(sameAddr), addressRotated: sum(rotated), idleAirBytesPer5Min: idleBytes };
}

async function threeDeviceJoin(params: Partial<SimParams>, n: number, v: Variant) {
  const w = world(params, 5);
  const o = { headersFirst: v.headersFirst, singleInitiator: v.singleInitiator, batchSize: v.batchSize, ble: { channel: v.deflate ? {} : { compressThreshold: Infinity } } };
  const a = await makeBleDevice(w, 'A', o);
  const b = await makeBleDevice(w, 'B', o);
  const c = await makeBleDevice(w, 'C', o);
  await seedTasks(a, n);
  await pairAll([a, b]);
  const cb = countPoller(w, b);
  await w.until(() => cb.n === n, { what: 'B', maxVirtualMs: 6 * 3_600_000 });
  await w.advance(3000);
  const bIn = b.ble.wireStats().frameBytesIn;
  await pairAll([a, c]);
  await pairAll([b, c]);
  const t0 = w.clock.now();
  const cc = countPoller(w, c);
  await w.until(() => cc.n === n, { what: 'C', maxVirtualMs: 6 * 3_600_000 });
  const ms = w.clock.now() - t0;
  await w.advance(10_000);
  const out = { cJoinToCompleteMs: Math.round(ms), cReceivedFrameKB: r1(c.ble.wireStats().frameBytesIn / 1024), bReceivedFrameKBFromOneNeighbour: r1(bIn / 1024) };
  await stopAll();
  return out;
}

async function main() {
  const out: Record<string, unknown> = { note: 'virtual time on the simulated radio; see docs/perf/phase4.md', node: process.version, machine: `${process.platform}/${process.arch}` };
  const profiles = Object.entries(PROFILES).filter(([k]) => !only.length || only.includes(k));
  const variants: Array<[string, Variant]> = [
    ['headersFirst+deflate', { headersFirst: true, deflate: true }],
    ['headersFirst, no deflate', { headersFirst: true, deflate: false }],
    ['no headersFirst, deflate', { headersFirst: false, deflate: true }],
    ['no headersFirst, no deflate', { headersFirst: false, deflate: false }],
  ];
  for (const [key, p] of profiles) {
    const { label, ...params } = p;
    const res: Record<string, unknown> = { profile: label };
    const init: Record<string, unknown> = {};
    for (const n of SIZES) {
      for (const [vn, v] of variants) {
        if (QUICK && n > 1000 && vn !== variants[0]![0]) continue;
        process.stderr.write(`[${key}] initial sync ${n} docs, ${vn}\n`);
        init[`${n} docs | ${vn}`] = await initialSync(params, n, v);
      }
    }
    res.initialSync = init;
    process.stderr.write(`[${key}] harder text\n`);
    res.initialSync1kHarderText = {
      'headersFirst+deflate': await initialSync(params, 1000, { headersFirst: true, deflate: true }, true),
      'headersFirst, no deflate': await initialSync(params, 1000, { headersFirst: true, deflate: false }, true),
    };
    process.stderr.write(`[${key}] batch sizes\n`);
    const batches: Record<string, unknown> = {};
    for (const bs of [25, 100, 500]) batches[`batchSize ${bs}`] = await initialSync(params, 1000, { headersFirst: true, deflate: true, batchSize: bs });
    res.batchSizes1k = batches;
    process.stderr.write(`[${key}] single change latency\n`);
    res.singleChange = await latency(params, { headersFirst: true, deflate: true }, 1000);
    process.stderr.write(`[${key}] reconnect\n`);
    res.reconnect = await reconnect(params, { headersFirst: true, deflate: true });
    process.stderr.write(`[${key}] third device joins\n`);
    const join: Record<string, unknown> = {};
    for (const [vn, v] of [
      ['headersFirst, both ends initiate', { headersFirst: true, deflate: true, singleInitiator: false }],
      ['headersFirst, single initiator', { headersFirst: true, deflate: true, singleInitiator: true }],
      ['no headersFirst, both ends initiate', { headersFirst: false, deflate: true, singleInitiator: false }],
    ] as Array<[string, Variant]>)
      join[vn] = await threeDeviceJoin(params, 1000, v);
    res.thirdDeviceJoin1k = join;
    out[key] = res;
  }
  console.log(JSON.stringify(out, null, 2));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
