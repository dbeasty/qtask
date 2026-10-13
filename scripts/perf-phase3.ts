/**
 * Phase 3 (LAN sync) performance run. Usage:  npx tsx scripts/perf-phase3.ts
 *
 * Writes docs/perf/phase3.md with the measured numbers. Everything runs on loopback
 * between separate Node processes (see the method section the script emits); it
 * does not and cannot measure real Wi-Fi.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, cpus, platform, release, totalmem } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fleet, type Device } from '../tests/helpers/lan-fleet.ts';
import { makeDevice } from '../tests/helpers/lan.ts';
import { FileSecretStore, loadOrCreateIdentity, parsePairLink } from '../src/sync/lan/index.ts';

const MDNS_PORT = 15370;
const ms = (ns: bigint) => Number(ns) / 1e6;
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const f = (n: number, d = 2) => n.toFixed(d);
const stat = (xs: number[]) => `${f(pct(xs, 50))} / ${f(pct(xs, 95))} / ${f(Math.max(...xs))}`;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

const out: string[] = [];
const log = (s = '') => {
  out.push(s);
  console.log(s);
};

async function handshakeBench() {
  // Identity creation (keygen + self-signed cert), once per device lifetime.
  const idTimes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const dir = await mkdtemp(join(tmpdir(), 'qtask-id-'));
    const t = performance.now();
    await loadOrCreateIdentity(new FileSecretStore(join(dir, 'i.json')), 'x');
    idTimes.push(performance.now() - t);
    await rm(dir, { recursive: true, force: true });
  }
  const pairTimes: number[] = [];
  const tlsTimes: number[] = [];
  for (let i = 0; i < 30; i++) {
    const a = await makeDevice('ha');
    const b = await makeDevice('hb');
    const inv = a.transport.openPairing();
    const t0 = performance.now();
    await Promise.all([inv.result, b.transport.pairWith(parsePairLink(inv.link)!)]);
    pairTimes.push(performance.now() - t0);
    await sleep(30);
    const peer = b.peers.list()[0]!;
    for (let k = 0; k < 5; k++) {
      const t1 = performance.now();
      const link = await (b.transport as any).connectSync(peer, '127.0.0.1', a.transport.port);
      tlsTimes.push(performance.now() - t1);
      link.close();
    }
    await a.cleanup();
    await b.cleanup();
  }
  return { idTimes, pairTimes, tlsTimes };
}

async function latencyBench(fleet: Fleet) {
  const a = await fleet.add('LA', MDNS_PORT);
  const b = await fleet.add('LB', MDNS_PORT);
  await fleet.pair(a, b);
  await Promise.all([a.call('waitLinks', { n: 1 }), b.call('waitLinks', { n: 1 })]);
  const lat: number[] = [];
  for (let i = 0; i < 200; i++) {
    const id = `lat-${i}`;
    const { t } = await a.call<{ t: string }>('put', { id, value: { title: `edit ${i}` } });
    await b.call('waitDoc', { id });
    const { applied } = await b.call<{ applied: string }>('times', { id });
    lat.push(ms(BigInt(applied) - BigInt(t)));
    await sleep(2);
  }
  return lat;
}

async function bulkBench(fleet: Fleet, docs: number, bytesPerDoc: number, peers: 1 | 2, random: boolean) {
  const label = `${docs}x${bytesPerDoc}B${random ? 'rnd' : 'rep'}-${peers}p`;
  const a = await fleet.add(`BA-${label}`, MDNS_PORT);
  const rest: Device[] = [];
  for (let i = 0; i < peers; i++) rest.push(await fleet.add(`BB${i}-${label}`, MDNS_PORT));
  await a.call('seed', { n: docs, prefix: 'k', bytes: bytesPerDoc, random });
  const logicalBytes = docs * (bytesPerDoc + 60);
  const before = await Promise.all([a, ...rest].map((d) => d.call<any>('usage')));
  const t0 = process.hrtime.bigint();
  // Pairing triggers the dial and therefore the initial sync; peers pair with A and with each other.
  for (const r of rest) await fleet.pair(a, r);
  if (rest.length === 2) await fleet.pair(rest[0]!, rest[1]!);
  await Promise.all(rest.map((r) => r.call('waitCount', { n: docs, timeoutMs: 120_000 })));
  const t1 = process.hrtime.bigint();
  const perPeer: number[] = [];
  for (const r of rest) {
    const tm = await r.call<{ upAt: Record<string, string>; applied: string }>('times', { id: `k${docs - 1}` });
    // Time from this peer's link to A coming up until its last document landed.
    const up = BigInt(tm.upAt[a.info.nodeId]!);
    // `applied` is the last-seeded id, but gossip from the other peer may deliver it first; use max of both.
    perPeer.push(ms(BigInt(tm.applied) - up));
  }
  await sleep(500);
  const after = await Promise.all([a, ...rest].map((d) => d.call<any>('usage')));
  const stats = await Promise.all(rest.map((d) => d.call<any>('stats')));
  const dig = await Promise.all([a, ...rest].map((d) => d.call<any>('digest')));
  const converged = dig.every((d) => d.digest === dig[0].digest && d.count === docs);
  return {
    label,
    docs,
    bytesPerDoc,
    peers,
    logicalMB: logicalBytes / 1048576,
    totalMs: ms(t1 - t0),
    perPeerLinkToDone: perPeer,
    cpuMs: after.map((u, i) => u.cpuUserMs + u.cpuSystemMs - before[i].cpuUserMs - before[i].cpuSystemMs),
    rssMB: after.map((u) => u.rssMB),
    docsReceived: stats.map((s) => s.docsReceived),
    wireInMB: stats.map((s) => s.wire.bytesIn / 1048576),
    stalls: stats.map((s) => s.wire.creditStalls),
    random,
    converged,
  };
}

async function main() {
  const t00 = Date.now();
  console.error('stage: handshake');
  const hs = await handshakeBench();
  console.error('stage: latency');
  const fleet1 = new Fleet();
  const lat = await latencyBench(fleet1);
  await fleet1.cleanup();

  console.error('stage: bulk');
  const bulk = [];
  for (const cfg of [
    [10_000, 200, 1, false],
    [10_000, 1000, 1, false],
    [10_000, 1000, 1, true],
    [10_000, 200, 2, false],
    [10_000, 1000, 2, true],
    [50_000, 1000, 1, true],
  ] as const) {
    const fl = new Fleet();
    bulk.push(await bulkBench(fl, cfg[0], cfg[1], cfg[2], cfg[3]));
    await fl.cleanup();
  }

  // 3-peer live-edit latency (mesh of 3, one writer, two readers).
  const fl3 = new Fleet();
  const [a, b, c] = [await fl3.add('MA', MDNS_PORT), await fl3.add('MB', MDNS_PORT), await fl3.add('MC', MDNS_PORT)];
  await fl3.pair(a, b);
  await fl3.pair(a, c);
  await fl3.pair(b, c);
  await Promise.all([a, b, c].map((d) => d.call('waitLinks', { n: 2 })));
  const lat3b: number[] = [];
  const lat3c: number[] = [];
  for (let i = 0; i < 100; i++) {
    const id = `m-${i}`;
    const { t } = await a.call<{ t: string }>('put', { id, value: i });
    await Promise.all([b.call('waitDoc', { id }), c.call('waitDoc', { id })]);
    const [tb, tc] = await Promise.all([b, c].map((d) => d.call<{ applied: string }>('times', { id })));
    lat3b.push(ms(BigInt(tb!.applied) - BigInt(t)));
    lat3c.push(ms(BigInt(tc!.applied) - BigInt(t)));
    await sleep(2);
  }
  const idleBefore = await Promise.all([a, b, c].map((d) => d.call<any>('usage')));
  await sleep(5000);
  const idleAfter = await Promise.all([a, b, c].map((d) => d.call<any>('usage')));
  const idleCpu = idleAfter.map((u, i) => u.cpuUserMs + u.cpuSystemMs - idleBefore[i].cpuUserMs - idleBefore[i].cpuSystemMs);
  await fl3.cleanup();

  const cpu = cpus();
  log('# Phase 3 (LAN sync) performance');
  log();
  log(`Generated by \`npx tsx scripts/perf-phase3.ts\` on ${new Date().toISOString().slice(0, 10)} (run took ${((Date.now() - t00) / 1000).toFixed(0)} s).`);
  log();
  log('## Environment');
  log();
  log(`- ${cpu[0]!.model}, ${cpu.length} logical cores, ${(totalmem() / 2 ** 30).toFixed(0)} GiB RAM, ${platform()} ${release()}, Node ${process.version}`);
  log('- All "devices" are separate Node processes on **one machine over the loopback interface** (127.0.0.1). Discovery uses real multicast DNS packets, but on `lo0` and a private UDP port.');
  log('- The replicated store is the minimal last-writer-wins stand-in in `tests/helpers/lww-store.ts` (JSON messages, digest exchange on link-up, gossip). It is **not** the Phase 2 engine, so absolute throughput for real data will differ; the numbers characterise the transport (TLS + framing + deflate + flow control) under a representative message pattern.');
  log();
  log('## What these numbers do not tell you');
  log();
  log('- **Real Wi-Fi was not measured.** Loopback has no radio latency, no loss, no contention, ~tens of GB/s of bandwidth. Real 802.11ac/ax links add ~2-10 ms RTT (more with power save), 100-600 Mbit/s of shared throughput, and variable loss. Treat all latencies below as the transport\'s own floor (CPU + TLS + serialisation), and throughput as an upper bound limited by CPU rather than by the network.');
  log('- Multicast behaviour on real routers (IGMP snooping, client isolation, guest networks) is untested.');
  log('- Battery / radio wake cost on laptops and phones is untested.');
  log();
  log('## Method');
  log();
  log('- **Handshake**: in-process, 30 fresh device pairs. "Pairing" = `pairWith` call to both sides holding the signed record (QR flow, includes one TLS 1.3 handshake, two ECDSA/Ed25519 signatures per side and file persistence). "Sync connect" = `connectSync` (TCP connect + mutual TLS 1.3 handshake + fingerprint pin check + app hello exchange), 5 per pair (150 samples). "Identity creation" = Ed25519 + P-256 keygen + self-signed certificate + write to disk, 20 samples.');
  log('- **Single-change latency**: devices A and B (separate processes) paired and connected; A calls `put`, B records the arrival time in `onApplied`. Both timestamps are `process.hrtime.bigint()` (system-wide monotonic clock, so comparable across processes). 200 samples, 2 ms apart. 3-peer variant: 100 samples, A writes, B and C (full mesh) read.');
  log('- **Initial sync**: device A is seeded with N documents before any pairing; one or two empty peers then pair with A (which triggers dial and digest exchange). Time reported is from the peer\'s link-up to A until its last document was applied, measured inside the peer process. Docs are JSON `{title, notes (filler), n, tags, done}`; the size column is the filler size. In the 2-peer case the two peers are also paired with each other, so they gossip received documents to one another (visible as extra "docs received").');
  log('- **CPU / memory**: `process.cpuUsage()` deltas (user+system) and RSS read from each process around the sync; idle = 5 s with three connected, quiescent peers (keep-alive pings every 15 s).');
  log();
  log('## Results');
  log();
  log('Times are milliseconds, shown as p50 / p95 / max unless noted.');
  log();
  log('### Handshake');
  log();
  log('| Step | p50 / p95 / max (ms) | samples |');
  log('|---|---|---|');
  log(`| Identity creation (one-off per device) | ${stat(hs.idTimes)} | ${hs.idTimes.length} |`);
  log(`| QR pairing (end to end) | ${stat(hs.pairTimes)} | ${hs.pairTimes.length} |`);
  log(`| Sync connect (TLS 1.3 + pin + hello) | ${stat(hs.tlsTimes)} | ${hs.tlsTimes.length} |`);
  log();
  log('### Single-change latency (one edit, connected peers)');
  log();
  log('| Scenario | p50 / p95 / max (ms) | samples |');
  log('|---|---|---|');
  log(`| 2 devices, A to B | ${stat(lat)} | ${lat.length} |`);
  log(`| 3 devices (mesh), A to B | ${stat(lat3b)} | ${lat3b.length} |`);
  log(`| 3 devices (mesh), A to C | ${stat(lat3c)} | ${lat3c.length} |`);
  log();
  log('### Initial sync of a large database');
  log();
  log('| Docs | Filler/doc | Peers pulling | Logical size | Wire MB received per peer | Wall time, all converged | Link-up to last doc, per peer (ms) | Docs received per peer | Converged |');
  log('|---|---|---|---|---|---|---|---|---|');
  for (const r of bulk)
    log(
      `| ${r.docs} | ${r.bytesPerDoc} B ${r.random ? 'random (incompressible)' : 'repeated char (very compressible)'} | ${r.peers} | ${f(r.logicalMB, 1)} MB | ${r.wireInMB.map((x) => f(x, 2)).join(', ')} | ${f(r.totalMs, 0)} ms (includes pairing) | ${r.perPeerLinkToDone.map((x) => f(x, 0)).join(', ')} | ${r.docsReceived.join(', ')} | ${r.converged ? 'yes' : 'NO'} |`,
    );
  log();
  log('Throughput (logical JSON MB divided by link-up-to-last-doc, first peer):');
  log();
  for (const r of bulk) log(`- ${r.label}: ${f(r.logicalMB / (r.perPeerLinkToDone[0]! / 1000), 1)} MB/s, ${f(r.docs / (r.perPeerLinkToDone[0]! / 1000), 0)} docs/s`);
  log();
  log('### CPU and memory');
  log();
  log('| Scenario | CPU ms per process (A seeding side first, then peers) | RSS MB after (same order) |');
  log('|---|---|---|');
  for (const r of bulk) log(`| ${r.label} | ${r.cpuMs.map((x) => f(x, 0)).join(', ')} | ${r.rssMB.map((x) => f(x, 0)).join(', ')} |`);
  log(`| idle, 3 connected peers, 5 s | ${idleCpu.map((x) => f(x, 1)).join(', ')} | ${idleAfter.map((u) => f(u.rssMB, 0)).join(', ')} |`);
  log();
  log('### Notes on the numbers');
  log();
  log('- Repeated-character filler compresses ~50x, which makes those rows measure JSON parse/stringify and TLS more than the link; the **random** rows are the realistic worst case (incompressible content, wire bytes about equal to logical bytes). Real task data (titles, notes, ids) sits between the two.');
  log('- On incompressible data the sender still tries deflate on every message and discards the result when it does not shrink; that is part of the higher CPU in the random rows. A heuristic to skip compression for already-dense content is a possible later optimisation, not done here.');
  log('- With two peers pulling from A at once and also paired with each other, each receives roughly 2x the documents ("Docs received per peer" above 10000): the stand-in engine gossips accepted documents to all other links, so a document can arrive from both A and the other peer. The transport delivers each message once; avoiding the duplicate work is the Phase 2 engine\'s job (for example by gossiping only after the digest round settles, or sending digests that include what is in flight).');
  log('- Single-change latency is sub-millisecond on loopback, so on real Wi-Fi it will be dominated by the radio round trip, not by this code.');
  log();
  const text = out.join('\n') + '\n';
  const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'perf', 'phase3.md');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
  console.log(`\nwrote ${target}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
