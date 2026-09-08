/**
 * Backend selection and the process-wide store handle.
 *
 * `DATA_MONGO` and `DATA_KDB` are mutually exclusive deployment flags, resolved once
 * at first use in the same shape as `resolveMailProvider`. Mongo is the default, so
 * a deployment that sets neither keeps working exactly as it did.
 *
 * `DATA_SHADOW_WRITES` layers on top: the resolved backend still answers every read
 * and owns every result, while the *other* backend receives a mirrored copy of each
 * write. See shadow/store.ts for why that is worth doing and what it deliberately
 * does not do.
 */

import { createLogger } from '../utils/logger.js';
import type { CollectionName, Collection, DataStore, Doc } from './types.js';

const log = createLogger('data');

export type DataBackend = 'mongo' | 'kdb';

/**
 * Resolves the backend from the deployment flags. Setting both is a configuration
 * error rather than a precedence puzzle: with two stores wired up, silently picking
 * one means half a deployment could read from the other.
 */
export function resolveDataBackend(env: NodeJS.ProcessEnv = process.env): DataBackend {
  const wantsMongo = env.DATA_MONGO === 'true';
  const wantsKdb = env.DATA_KDB === 'true';

  if (wantsMongo && wantsKdb) {
    throw new Error('DATA_MONGO and DATA_KDB are mutually exclusive — set exactly one');
  }
  if (wantsKdb) return 'kdb';
  return 'mongo';
}

let store: DataStore | undefined;

/** The active store. Created on first use, so the flags are read after dotenv has run. */
export function getDataStore(): DataStore {
  if (!store) throw new Error('Data store is not connected — call connectData() first');
  return store;
}

/**
 * Whether writes are mirrored to the other backend. Off unless explicitly enabled —
 * a deployment that has not opted in pays nothing for this existing.
 */
export function shadowWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DATA_SHADOW_WRITES === 'true';
}

/**
 * Whether reads are also asked of the shadow and compared.
 *
 * Requires shadow writes: without them the shadow holds no data, so every single
 * read would "diverge" and the signal would be worthless. Rather than silently
 * enabling writes or silently ignoring the flag, this is a startup error — an
 * operator who asked for read comparison and got neither deserves to be told.
 */
export function shadowReadsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const wantsReads = env.DATA_SHADOW_READS === 'true';
  if (wantsReads && !shadowWritesEnabled(env)) {
    throw new Error(
      'DATA_SHADOW_READS requires DATA_SHADOW_WRITES — without mirrored writes the ' +
        'shadow holds no data and every read would diverge'
    );
  }
  return wantsReads;
}

/**
 * Fraction of reads to compare, 0..1. Comparing every read doubles read work, and
 * on a backend that scans rather than indexes that is the dominant cost — so a bake
 * under real traffic will usually want this well below 1. Defaults to comparing
 * everything, because a bake that silently sampled 1% would look far cleaner than
 * the evidence supports.
 */
export function shadowReadSampleRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DATA_SHADOW_READ_SAMPLE;
  if (raw === undefined || raw === '') return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`DATA_SHADOW_READ_SAMPLE must be a number between 0 and 1, got "${raw}"`);
  }
  return parsed;
}

export async function connectData(): Promise<DataStore> {
  if (store) return store;
  const backend = resolveDataBackend();
  const primary = await createStore(backend);

  if (!shadowWritesEnabled()) {
    await primary.connect();
    store = primary;
    return store;
  }

  const shadowBackend: DataBackend = backend === 'mongo' ? 'kdb' : 'mongo';
  const compareReads = shadowReadsEnabled();
  const { ShadowDataStore, ShadowUnavailableError } = await import('./shadow/store.js');
  const shadowed = new ShadowDataStore(primary, await createStore(shadowBackend), {
    compareReads,
    readSampleRate: shadowReadSampleRate(),
  });

  try {
    await shadowed.connect();
    log.info('shadow writes enabled', {
      primary: backend,
      shadow: shadowBackend,
      compareReads,
      readSampleRate: compareReads ? shadowReadSampleRate() : undefined,
    });
    store = shadowed;
  } catch (error) {
    if (!(error instanceof ShadowUnavailableError)) throw error;
    // The primary is already open at this point, and the whole premise is that the
    // request path does not depend on the shadow. Refusing to start because the
    // backend being *evaluated* is down would invert that.
    log.error('continuing on the primary alone; shadow writes are off', {
      primary: backend,
      shadow: shadowBackend,
    });
    store = primary;
  }
  return store;
}

export async function disconnectData(): Promise<void> {
  if (!store) return;
  await store.disconnect();
  store = undefined;
}

async function createStore(backend: DataBackend): Promise<DataStore> {
  if (backend === 'kdb') {
    const { KdbDataStore } = await import('./kdb/store.js');
    return new KdbDataStore();
  }
  const { MongoDataStore } = await import('./mongo/store.js');
  return new MongoDataStore();
}

/**
 * What the data layer is doing right now, for /health.
 *
 * Stage 2 exists to measure the candidate backend under real write traffic, and a
 * measurement nobody can see is not one. `failed` and `dropped` are the numbers that
 * decide whether the migration advances: failures mean the shadow cannot keep up
 * semantically, drops mean it cannot keep up at all.
 */
export function getDataHealth(): Record<string, unknown> {
  if (!store) return { backend: 'disconnected' };
  const shadowed = store as Partial<{
    shadowBackend: 'mongo' | 'kdb';
    stats: () => Record<string, unknown>;
    readStats: () => Record<string, unknown> | undefined;
  }>;
  if (typeof shadowed.stats !== 'function') {
    return { backend: store.backend, shadowWrites: false };
  }
  const readStats = shadowed.readStats?.();
  return {
    backend: store.backend,
    shadowWrites: true,
    shadowBackend: shadowed.shadowBackend,
    shadow: shadowed.stats(),
    shadowReads: readStats !== undefined,
    ...(readStats ? { reads: readStats } : {}),
  };
}

/** Shorthand for `getDataStore().collection(name)`, which is how services read. */
export function collection<T extends Doc = Doc>(name: CollectionName): Collection<T> {
  return getDataStore().collection<T>(name);
}

export type { Collection, CollectionName, DataStore, Doc } from './types.js';
export type { Filter, FindOptions, Sort, Update, UpdateOptions } from './types.js';
