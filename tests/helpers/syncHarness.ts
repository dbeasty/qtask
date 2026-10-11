/**
 * Test and benchmark support: in-memory peers wired together over loopback.
 */

import { MemoryDataStore } from '../../src/data/memory/store.ts';
import { createDefaultDerived } from '../../src/sync/derived.ts';
import { SyncEngine } from '../../src/sync/engine.ts';
import { MemoryMetaStore } from '../../src/sync/meta.ts';
import { SyncDataStore } from '../../src/sync/tracker.ts';
import { LoopbackTransport } from '../../src/sync/transport.ts';
import type { Doc } from '../../src/data/types.ts';
import type { SyncAuthorizer } from '../../src/sync/types.ts';

export interface Peer {
  name: string;
  inner: MemoryDataStore;
  store: SyncDataStore;
  meta: MemoryMetaStore;
  engine: SyncEngine;
}

export async function makePeer(
  name: string,
  options: { role?: 'hub' | 'device'; now?: () => number; derived?: boolean; batchSize?: number } = {}
): Promise<Peer> {
  const inner = new MemoryDataStore();
  const meta = new MemoryMetaStore({ nodeId: name });
  const store = new SyncDataStore(inner, meta, options.now);
  const engine = new SyncEngine({
    store,
    meta,
    role: options.role ?? 'device',
    now: options.now,
    batchSize: options.batchSize,
    derived: options.derived ? createDefaultDerived() : undefined,
  });
  await engine.init();
  return { name, inner, store, meta, engine };
}

export function link(client: Peer, server: Peer, authorizer?: SyncAuthorizer): LoopbackTransport {
  return new LoopbackTransport(server.engine.service(authorizer));
}

/** Syncs every ordered pair until a full pass moves nothing. Returns the passes taken. */
export async function settle(peers: Peer[], maxPasses = 12): Promise<number> {
  for (let pass = 1; pass <= maxPasses; pass++) {
    let moved = 0;
    for (const a of peers) {
      for (const b of peers) {
        if (a === b) continue;
        const result = await a.engine.syncWith(link(a, b));
        moved += result.pulled + result.pushed;
      }
    }
    if (moved === 0) return pass;
  }
  throw new Error(`peers did not settle within ${maxPasses} passes`);
}

/** Replicated content of a collection as `id -> doc`, minus fields that are local or derived. */
export async function snapshot(
  peer: Peer,
  coll: 'tasks' | 'projects' | 'comments' | 'activities' = 'tasks',
  ignore: string[] = ['updatedAt', 'percentComplete', 'status', 'trackingRollup']
): Promise<Record<string, Doc>> {
  const docs = await peer.inner.collection(coll).find({});
  const out: Record<string, Doc> = {};
  for (const doc of docs) {
    const copy: Doc = { ...doc };
    for (const key of ignore) delete copy[key];
    out[String(doc._id)] = copy;
  }
  return out;
}
