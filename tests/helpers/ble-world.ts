/**
 * Test and perf support for the Bluetooth transport: devices with real identities,
 * real pairing records, the real SyncEngine and BleTransport, on a SimulatedRadio world
 * with virtual time. See src/sync/ble/sim.ts for what the simulation does and does not model.
 */

import { createHash } from 'node:crypto';
import { MemoryDataStore } from '../../src/data/memory/store.ts';
import { SyncEngine } from '../../src/sync/engine.ts';
import { MemoryMetaStore } from '../../src/sync/meta.ts';
import { SyncDataStore } from '../../src/sync/tracker.ts';
import {
  LanSyncCoordinator,
  PeerStore,
  loadOrCreateIdentity,
  signRecordBody,
  type DeviceIdentity,
  type PairingRecord,
  type SecretStore,
} from '../../src/sync/lan/index.ts';
import { BleTransport, type BleTransportOptions } from '../../src/sync/ble/transport.ts';
import { SimWorld, type SimParams, type SimRadio } from '../../src/sync/ble/sim.ts';
import type { PeerLinkTransport } from '../../src/sync/transport-contract.ts';

class MemSecret implements SecretStore {
  private v: string | null = null;
  async load() {
    return this.v;
  }
  async save(d: string) {
    this.v = d;
  }
}

export interface BleDevice {
  name: string;
  identity: DeviceIdentity;
  peers: PeerStore;
  radio: SimRadio;
  ble: BleTransport;
  /** What the coordinator runs over (the BleTransport, or a selector around it). */
  transport: PeerLinkTransport;
  store: SyncDataStore;
  engine: SyncEngine;
  coordinator: LanSyncCoordinator;
  rounds: number;
  errors: string[];
  results: Array<{ pulled: number; pushed: number; conflicts: number }>;
  tasks(): ReturnType<SyncDataStore['collection']>;
  digest(): Promise<{ count: number; digest: string }>;
}

export interface DeviceOptions {
  mtu?: number;
  batchSize?: number;
  headersFirst?: boolean;
  /** Only the lower node id starts a round when a link comes up (the other end serves, with a fallback). */
  singleInitiator?: boolean;
  /** Put something between the transport and the simulated radio (for example the bridge). */
  radioWrap?: (sim: SimRadio) => import('../../src/sync/ble/radio.ts').BleRadio;
  ble?: Partial<BleTransportOptions>;
  /** Wrap or replace the transport the coordinator runs over (for example a TransportSelector). */
  transport?: (ble: BleTransport, d: { name: string; identity: DeviceIdentity; peers: PeerStore }) => PeerLinkTransport;
  /** Do not start the coordinator and transport yet. */
  deferStart?: boolean;
}

const created: BleDevice[] = [];

/** Stops every device made since the last call: closes links so no pending request timer outlives its test. */
export async function stopAll(): Promise<void> {
  const devs = created.splice(0);
  await Promise.all(devs.map((d) => d.transport.stop().catch(() => undefined)));
}

export async function makeBleDevice(world: SimWorld, name: string, o: DeviceOptions = {}): Promise<BleDevice> {
  const identity = await loadOrCreateIdentity(new MemSecret(), name);
  const peers = await PeerStore.open(identity, null);
  const radio = world.createRadio(name, { mtu: o.mtu });
  const ble = new BleTransport({
    identity,
    peers,
    radio: o.radioWrap ? o.radioWrap(radio) : radio,
    timers: world.clock,
    backoff: { minMs: 1000, maxMs: 15_000 },
    ...o.ble,
  });
  const transport = o.transport ? o.transport(ble, { name, identity, peers }) : ble;
  const meta = new MemoryMetaStore({ nodeId: name });
  const store = new SyncDataStore(new MemoryDataStore(), meta);
  const engine = new SyncEngine({ store, meta, role: 'device', batchSize: o.batchSize });
  await engine.init();
  const dev: BleDevice = {
    name,
    identity,
    peers,
    radio,
    ble,
    transport,
    store,
    engine,
    rounds: 0,
    errors: [],
    results: [],
    coordinator: undefined as unknown as LanSyncCoordinator,
    tasks: () => store.collection('tasks'),
    async digest() {
      const docs = (await store.collection('tasks').find({})).map((d) => ({
        id: String(d._id),
        title: d.title,
        done: d.done ?? false,
        notes: d.notes ?? null,
      }));
      docs.sort((a, b) => (a.id < b.id ? -1 : 1));
      return { count: docs.length, digest: createHash('sha256').update(JSON.stringify(docs)).digest('hex') };
    },
  };
  dev.coordinator = new LanSyncCoordinator(engine, transport, {
    headersFirst: o.headersFirst,
    ...(o.singleInitiator ? { shouldInitiate: (l: { peerId: string }) => identity.info.nodeId < l.peerId, timers: world.clock, passiveFallbackMs: 15_000 } : {}),
    onResult: (_p, r) => {
      dev.rounds++;
      dev.results.push({ pulled: r.pulled, pushed: r.pushed, conflicts: r.conflicts });
    },
    onError: (_p, e) => void dev.errors.push(e.message),
  });
  created.push(dev);
  if (!o.deferStart) await startDevice(dev);
  return dev;
}

export async function startDevice(d: BleDevice): Promise<void> {
  d.coordinator.start();
  await d.transport.start();
}

/** Adds a pairing record signed by both devices to both PeerStores (what a completed pairing produces). */
export interface Party {
  identity: DeviceIdentity;
  peers: PeerStore;
}

/** An identity and an empty PeerStore, no radio: for tunnel-level tests. */
export async function makeParty(name: string): Promise<Party> {
  const identity = await loadOrCreateIdentity(new MemSecret(), name);
  return { identity, peers: await PeerStore.open(identity, null) };
}

export async function pair(a: Party, b: Party): Promise<PairingRecord> {
  const body = { v: 1 as const, ts: 1_700_000_000_000, a: a.identity.info, b: b.identity.info };
  const rec: PairingRecord = { ...body, sigA: signRecordBody(a.identity, body), sigB: signRecordBody(b.identity, body) };
  await a.peers.add(rec);
  await b.peers.add(rec);
  return rec;
}

export async function pairAll(devs: Party[]): Promise<void> {
  for (let i = 0; i < devs.length; i++) for (let j = i + 1; j < devs.length; j++) await pair(devs[i]!, devs[j]!);
}

export function world(params: Partial<SimParams> = {}, seed = 1): SimWorld {
  return new SimWorld(params, seed);
}

export async function converged(w: SimWorld, devs: BleDevice[], count: number, opts: { maxVirtualMs?: number } = {}) {
  await w.until(
    async () => {
      const ds = await Promise.all(devs.map((d) => d.digest()));
      return ds.every((d) => d.count === count && d.digest === ds[0]!.digest);
    },
    { what: `${devs.map((d) => d.name).join(',')} to hold ${count} docs`, ...opts },
  );
}

export async function linked(w: SimWorld, a: BleDevice, b: BleDevice) {
  await w.until(() => a.transport.links().some((l) => l.peerId === b.identity.info.nodeId) && b.transport.links().some((l) => l.peerId === a.identity.info.nodeId), {
    what: `${a.name}<->${b.name} link`,
  });
  // Let a simultaneous-connect race settle so tests do not grab a link that is about to be replaced.
  await w.advance(2500);
}

// --- realistic task text -------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ['Review', 'Draft', 'Send', 'Fix', 'Call', 'Schedule', 'Update', 'Book', 'Order', 'Prepare', 'Finish', 'Check', 'Write', 'Plan', 'Renew', 'Cancel', 'Follow up on', 'Pick up', 'Sort out', 'Reply to', 'Compare', 'Test', 'Deploy', 'Refactor', 'Document', 'Pay', 'Clean', 'Return', 'Research', 'Confirm'];
const OBJECTS = ['the quarterly report', 'invoice 4821', 'landlord about the boiler', 'dentist appointment', 'flights to Lisbon', 'the onboarding checklist', 'login timeout bug', 'team offsite agenda', 'passport renewal', 'birthday present for Maya', 'the staging deploy', 'tax documents', 'car insurance quote', 'grocery delivery', 'slides for Thursday', 'API rate limit docs', 'new laptop options', 'gym membership', 'contract with Northwind', 'the failing CI job', 'wedding RSVP', 'expense claims', 'garden furniture', 'client feedback survey', 'database migration plan', 'conference talk proposal', 'roof inspection', 'pension statement', 'recipe for Sunday', 'customer interview notes', 'the printer driver', 'vendor security questionnaire', 'house keys copy', 'hiring scorecard', 'mobile release notes', 'library books'];
const TAILS = ['before Friday', 'and CC Priya', 'once Tom confirms', 'if the budget allows', 'with the updated numbers', 'for the Monday standup', 'before the end of the month', 'after lunch', 'using the new template', 'and note the outcome here', 'this week', 'but only if it is still needed', 'and ask about the discount', 'and attach the receipts'];
const NOTE_BITS = ['Waiting on a reply from {n}.', 'See ticket QT-{k} for the background.', 'Last time this took about {m} minutes.', 'Remember to check the shared drive first.', 'Ask {n} whether the deadline moved.', 'The account number is in the password manager, not in this note.', 'Needs approval from {n} before anything is sent.', 'Draft is in the usual folder, version {k}.', 'Do this in one sitting; context switching made it slow last month.', 'Budget is roughly {k}00 so check the quote.', 'Not urgent, but it blocks the {o} work.', 'Phone ahead, they close at {m}.'];
const NAMES = ['Priya', 'Tom', 'Maya', 'Jonas', 'Aisha', 'Lena', 'Carlos', 'Noor', 'Wei', 'Sam', 'Ingrid', 'Dev'];
const TAGS = ['home', 'work', 'finance', 'health', 'errand', 'urgent', 'waiting', 'reading', 'admin', 'travel', 'planning', 'bug', 'review', 'family'];

const SYL = ['ba', 'ko', 'ri', 'mel', 'tan', 'dor', 'vi', 'lu', 'sen', 'pra', 'qui', 'zo', 'han', 'fe', 'ghi', 'wor', 'nu', 'cal', 'ste', 'ju', 'rem', 'ax', 'bri', 'pol', 'dis', 'ev', 'tro', 'lin', 'mo', 'ka'];
let VOCAB: string[] | null = null;
/** A 4,000-word pseudo-vocabulary with a Zipf-like frequency: a deliberately harder-to-compress stand-in for free text. */
function vocab(): string[] {
  if (VOCAB) return VOCAB;
  const r = rng(99);
  VOCAB = Array.from({ length: 4000 }, () => Array.from({ length: 1 + Math.floor(r() * 3) }, () => SYL[Math.floor(r() * SYL.length)]!).join(''));
  return VOCAB;
}

/**
 * A task shaped like what people actually type: short imperative titles, sometimes a few sentences of notes.
 * `hard` adds longer free-text notes made of pseudo-words with a Zipf-like distribution and random reference
 * numbers, which compress much worse than the template text above (so it is a more pessimistic wire-size case).
 */
export function realisticTask(i: number, seed = 7, hard = false): Record<string, unknown> {
  const r = rng(seed * 1_000_003 + i);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const title = `${pick(VERBS)} ${pick(OBJECTS)}${r() < 0.4 ? ` ${pick(TAILS)}` : ''}`;
  let notes = '';
  const nNotes = r() < 0.35 ? 0 : 1 + Math.floor(r() * r() * 5);
  for (let k = 0; k < nNotes; k++) {
    notes += (k ? ' ' : '') + pick(NOTE_BITS).replace('{n}', pick(NAMES)).replace('{k}', String(Math.floor(r() * 9000) + 100)).replace('{m}', String(Math.floor(r() * 55) + 5)).replace('{o}', pick(OBJECTS));
  }
  const tags = Array.from(new Set(Array.from({ length: Math.floor(r() * 3) }, () => pick(TAGS))));
  const doc: Record<string, unknown> = {
    title,
    notes,
    tags,
    priority: pick(['low', 'medium', 'medium', 'high']),
    done: r() < 0.3,
    estimateMinutes: [5, 10, 15, 30, 45, 60, 90, 120][Math.floor(r() * 8)],
    n: i,
  };
  if (r() < 0.5) doc.dueDate = new Date(Date.UTC(2026, 9, 1 + Math.floor(r() * 120)));
  if (hard) {
    const v = vocab();
    const words = Array.from({ length: r() < 0.6 ? 12 + Math.floor(r() * 60) : 0 }, () => v[Math.floor(v.length * Math.pow(r(), 2.2))]!);
    if (words.length) doc.notes = `${notes} ${words.join(' ')} ref ${Math.floor(r() * 1e8)}`.trim();
    doc.title = `${title} ${v[Math.floor(v.length * r())]} ${v[Math.floor(v.length * r())]}`;
  }
  return doc;
}

export async function seedTasks(d: BleDevice, n: number, prefix = 'task-', offset = 0, hard = false): Promise<number> {
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const doc = realisticTask(i + offset, 7, hard);
    bytes += JSON.stringify(doc).length;
    await d.tasks().create({ _id: `${prefix}${i + offset}`, userId: 'u1', ...doc });
  }
  return bytes;
}
