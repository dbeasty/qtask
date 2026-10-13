export { HybridClock, compareStamps, formatStamp, parseStamp, stampNode, stampWall } from './clock.js';
export { decodeValue, encodeValue, canonicalJson, hashEncoded } from './codec.js';
export { mergeRecords, type MergeOutcome, type FieldConflict } from './merge.js';
export { FileMetaPersistence, MemoryMetaStore, isLive, recKey } from './meta.js';
export type { DocRec, FieldRec, MetaStore, PeerCursor } from './meta.js';
export { SyncDataStore } from './tracker.js';
export { SyncEngine, SyncService, headerNeeded, type DerivedRecompute, type SyncEngineOptions, type SyncWithOptions } from './engine.js';
export { HttpSyncTransport, LoopbackTransport, SyncTransportError } from './transport.js';
export { HubAuthorizer, createSyncRouter, EXECUTOR_TASK_FIELDS } from './hub.js';
export { DeviceSyncClient, type ClientStatus, type ClientState, type DeviceSyncClientOptions } from './client.js';
export { adoptLocalAccount, type AdoptResult } from './adopt.js';
export { createDefaultDerived, recomputeProjects } from './derived.js';
export {
  LOCAL_ONLY_COLLECTIONS,
  REPLICATED_COLLECTIONS,
  computeScope,
  isDerivedField,
  isReplicated,
  isSyncedField,
} from './policy.js';
export { getHubEngine, hubSyncEnabled, installHubSync, initHubSync, flushHubSync, setHubEngine } from './runtime.js';
export * from './types.js';
