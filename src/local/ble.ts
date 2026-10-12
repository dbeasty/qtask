/**
 * Opt-in Bluetooth bridge for local mode. When the Mac app is started with Bluetooth
 * enabled (QTASK_BLE=1 in the app's environment) it launches this backend with
 * QTASK_BLE_BRIDGE=1; the backend then listens on a loopback port for the app's
 * CoreBluetooth radio (src/sync/ble/bridge.ts) and reports the port in its ready line.
 *
 * Nothing consumes the radio yet: the sync engine is not wired into local mode in this
 * phase. `bleRadio()` is where that wiring picks it up:
 *
 *   const radio = bleRadio();
 *   if (radio) new BleTransport({ identity, peers, radio }) ...
 */

import { BleBridgeServer, type BridgeRadio } from '../sync/ble/bridge.js';

let server: BleBridgeServer | null = null;

export async function startBleBridgeIfEnabled(env: NodeJS.ProcessEnv = process.env): Promise<{ port: number } | null> {
  if (env.QTASK_BLE_BRIDGE !== '1') return null;
  const token = env.QTASK_DEVICE_TOKEN;
  if (!token) throw new Error('QTASK_BLE_BRIDGE needs QTASK_DEVICE_TOKEN');
  if (server) return { port: server.port };
  server = new BleBridgeServer({ token });
  return { port: await server.listen() };
}

export function bleRadio(): BridgeRadio | null {
  return server?.radio ?? null;
}

export async function stopBleBridge(): Promise<void> {
  const s = server;
  server = null;
  await s?.close();
}
