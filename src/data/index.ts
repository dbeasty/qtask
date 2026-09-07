/**
 * Backend selection and the process-wide store handle.
 *
 * `DATA_MONGO` and `DATA_KDB` are mutually exclusive deployment flags, resolved once
 * at first use in the same shape as `resolveMailProvider`. Mongo is the default, so
 * a deployment that sets neither keeps working exactly as it did.
 */

import type { CollectionName, Collection, DataStore, Doc } from './types.js';

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

export async function connectData(): Promise<DataStore> {
  if (store) return store;
  const backend = resolveDataBackend();
  store = await createStore(backend);
  await store.connect();
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

/** Shorthand for `getDataStore().collection(name)`, which is how services read. */
export function collection<T extends Doc = Doc>(name: CollectionName): Collection<T> {
  return getDataStore().collection<T>(name);
}

export type { Collection, CollectionName, DataStore, Doc } from './types.js';
export type { Filter, FindOptions, Sort, Update, UpdateOptions } from './types.js';
