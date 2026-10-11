/**
 * Real sync engine over the real LAN transport, separate processes on loopback.
 * `npm run perf:lan-engine`. Loopback only: no radio, no Wi-Fi loss or multicast filtering.
 */
import { Fleet, ENGINE_WORKER } from '../tests/helpers/lan-fleet.ts';

const MDNS = 15390;
const N = Number(process.env.N ?? 10_000);
const BYTES = Number(process.env.BYTES ?? 200);
const fleet = new Fleet(ENGINE_WORKER);

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

async function main() {
  const [a, b, c] = await Promise.all([fleet.add('A', MDNS), fleet.add('B', MDNS), fleet.add('C', MDNS)]);
  const out: Record<string, unknown> = { machine: process.platform + '/' + process.arch, node: process.version, docs: N, bytesPerDoc: BYTES };

  // 1. single-change latency, 2 devices
  await fleet.pair(a, b);
  await Promise.all([a, b].map((d) => d.call('waitLinks', { n: 1 })));
  const lat: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    await a.call('create', { id: `lat-${i}`, doc: { title: 'x' } });
    await b.call('waitDigest', { count: i + 1 });
    lat.push(performance.now() - t0);
  }
  out.singleChange2Devices = { p50: Math.round(pct(lat, 0.5) * 10) / 10, p95: Math.round(pct(lat, 0.95) * 10) / 10, note: 'includes two IPC round trips and polling' };

  // 2. initial sync of N docs A -> B
  const before = (await b.call<any>('status')).wire;
  await a.call('bulk', { n: N, prefix: 'bulk-', bytes: BYTES });
  let t0 = performance.now();
  await b.call('waitDigest', { count: N + 100, timeoutMs: 120_000 });
  const initial = ms(t0);
  const after = (await b.call<any>('status')).wire;
  out.initialSync2Devices = { ms: initial, docsPerSec: Math.round((N / initial) * 1000), wireMBIn: +((after.bytesIn - before.bytesIn) / 1048576).toFixed(2) };

  // 3. a third device joins, pairs with A and B, pulls everything
  await fleet.pair(a, c);
  await fleet.pair(b, c);
  t0 = performance.now();
  await c.call('waitDigest', { count: N + 100, timeoutMs: 120_000 });
  const join = ms(t0);
  await new Promise((r) => setTimeout(r, 500));
  const sc = await c.call<any>('status');
  out.thirdDeviceCatchUp = { ms: join, wireMBIn: +(sc.wire.bytesIn / 1048576).toFixed(2), rounds: sc.rounds, errors: sc.errors.length };

  // 4. no-op round
  t0 = performance.now();
  await c.call('syncNow');
  out.noopRound3Devices = { ms: ms(t0) };

  // 5. incremental: 100 edits on A reach B and C
  t0 = performance.now();
  for (let i = 0; i < 100; i++) await a.call('update', { id: `bulk-${i}`, set: { done: true } });
  await new Promise<void>(async (resolve) => {
    for (;;) {
      const g = await Promise.all([b, c].map((d) => d.call<any>('get', { id: 'bulk-99' })));
      if (g.every((x) => x?.done === true)) return resolve();
      await new Promise((r) => setTimeout(r, 5));
    }
  });
  out.incremental100Edits = { ms: ms(t0) };

  out.usage = Object.fromEntries(await Promise.all([a, b, c].map(async (d) => [d.name, await d.call('usage')])));
  console.log(JSON.stringify(out, null, 2));
}
main().then(() => fleet.cleanup()).catch(async (e) => { console.error(e); await fleet.cleanup(); process.exit(1); });
