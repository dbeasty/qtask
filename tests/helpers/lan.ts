import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSecretStore,
  LanTransport,
  PeerStore,
  loadOrCreateIdentity,
  type LanTransportOptions,
} from '../../src/sync/lan/index.ts';

export interface TestDevice {
  dir: string;
  transport: LanTransport;
  peers: PeerStore;
  security: Array<{ reason: string }>;
  cleanup(): Promise<void>;
}

export async function makeDevice(name: string, extra: Partial<LanTransportOptions> = {}): Promise<TestDevice> {
  const dir = await mkdtemp(join(tmpdir(), `qtask-lan-${name}-`));
  const identity = await loadOrCreateIdentity(new FileSecretStore(join(dir, 'identity.json')), name);
  const peers = await PeerStore.open(identity, dir);
  const transport = new LanTransport({
    identity,
    peers,
    host: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    discovery: false,
    backoff: { minMs: 50, maxMs: 400 },
    keepAliveMs: 0,
    ...extra,
  });
  const security: Array<{ reason: string }> = [];
  transport.on('security', (e) => security.push(e));
  await transport.start();
  return {
    dir,
    transport,
    peers,
    security,
    async cleanup() {
      await transport.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(cond: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
