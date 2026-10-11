/**
 * Starts the backend in local mode: loopback only, on an OS-chosen port, and reports
 * that port to its supervisor. Imported by ./entry.ts once the environment is prepared;
 * not meant to be run directly.
 */

import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { disconnectDb } from '../db/connection.js';
import { resolveLocalConfig } from './config.js';
import { loadOrCreateDeviceIdentity } from './device.js';

/** The line the supervisor waits for on stdout. */
export const READY_PREFIX = 'QTASK_READY ';

export interface ReadyInfo {
  port: number;
  pid: number;
  deviceId: string;
}

export async function startLocalServer(): Promise<{ server: Server; ready: ReadyInfo }> {
  const local = resolveLocalConfig();
  const identity = loadOrCreateDeviceIdentity(local.dataDir);
  const app = await createApp();

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, local.host, () => resolve(s));
    s.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no TCP address');

  const ready: ReadyInfo = { port: address.port, pid: process.pid, deviceId: identity.deviceId };

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    // Closing the data layer is what flushes the store; the supervisor waits for exit.
    await disconnectDb().catch((error) => console.error('disconnect failed', error));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // A supervisor that holds our stdin open sets QTASK_EXIT_ON_STDIN_CLOSE=1: if it dies
  // without a chance to signal us, the pipe closes and we go with it rather than
  // lingering as an orphan. Off by default so a shell-launched process is not killed
  // by an empty stdin.
  if (process.env.QTASK_EXIT_ON_STDIN_CLOSE === '1') {
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    process.stdin.resume();
  }

  console.log(READY_PREFIX + JSON.stringify(ready));
  return { server, ready };
}
