/**
 * Process-wide wiring: the hub engine behind `/api/sync`, and the opt-in that wraps
 * the data store for change tracking.
 *
 * Off by default. `QTASK_SYNC_HUB=true` makes this process a hub (cloud); the
 * device build (Phase 1 local mode) builds its own engine and `DeviceSyncClient`
 * instead and does not go through here.
 */

import type { DataStore } from '../data/types.js';
import { createLogger } from '../utils/logger.js';
import { createDefaultDerived, type TouchedDoc } from './derived.js';
import { SyncEngine } from './engine.js';
import { FileMetaPersistence, MemoryMetaStore } from './meta.js';
import { SyncDataStore } from './tracker.js';

const log = createLogger('sync');

/** Embeddings never replicate, so every peer rebuilds its own for documents that arrived. */
async function queueEmbeddings(touched: ReadonlyArray<TouchedDoc>): Promise<void> {
  const { enqueueEmbeddingJob, enqueueProjectEmbeddingJob } = await import('../services/embeddingQueue.js');
  // Each enqueue is two small upserts; run them concurrently so a bulk initial sync
  // is not serialised behind one round trip per document.
  const jobs = touched.flatMap((doc) =>
    doc.coll === 'tasks'
      ? [() => enqueueEmbeddingJob(doc.id)]
      : doc.coll === 'projects'
        ? [() => enqueueProjectEmbeddingJob(doc.id)]
        : []
  );
  for (let i = 0; i < jobs.length; i += 50) await Promise.all(jobs.slice(i, i + 50).map((run) => run()));
}

let hubEngine: SyncEngine | undefined;
let persistence: FileMetaPersistence | undefined;

export function getHubEngine(): SyncEngine | undefined {
  return hubEngine;
}

export function setHubEngine(engine: SyncEngine | undefined): void {
  hubEngine = engine;
}

export function hubSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QTASK_SYNC_HUB === 'true';
}

/**
 * Wraps `store` for tracking and registers the hub engine. The sync records live in
 * `QTASK_SYNC_META_PATH` (a JSON snapshot) when set, otherwise in memory; in memory
 * means a restart re-baselines every document, which is correct but resets peer
 * cursors, so devices re-pull once.
 */
export async function installHubSync(store: DataStore, env: NodeJS.ProcessEnv = process.env): Promise<SyncDataStore> {
  let meta: MemoryMetaStore;
  const path = env.QTASK_SYNC_META_PATH;
  if (path) {
    const opened = await FileMetaPersistence.open(path);
    meta = opened.meta;
    persistence = opened.persistence;
  } else {
    log.warn(
      'QTASK_SYNC_META_PATH is not set: sync records are in memory, so a restart loses tombstones and peer cursors. Set it in production.'
    );
    meta = new MemoryMetaStore();
  }
  const tracked = new SyncDataStore(store, meta);
  const engine = new SyncEngine({ store: tracked, meta, role: 'hub', derived: createDefaultDerived(),
    afterApply: queueEmbeddings,
  });
  hubEngine = engine;
  // Baseline after the caller has connected; connectData() calls init() below.
  return tracked;
}

/** Runs the baseline scan once the underlying store is connected. */
export async function initHubSync(): Promise<void> {
  if (!hubEngine) return;
  const started = Date.now();
  await hubEngine.init();
  log.info('sync hub ready', { nodeId: hubEngine.nodeId, ms: Date.now() - started });
}

export async function flushHubSync(): Promise<void> {
  await persistence?.flush();
}
