/**
 * Bluetooth sync between two local-mode backends in separate processes, with Wi-Fi
 * sync switched off (QTASK_SYNC_LAN=0), through the app<->node Bluetooth bridge.
 *
 * Each backend opens its bridge (QTASK_BLE_BRIDGE=1) exactly as when the Mac app starts
 * it. Where the app would connect CoreBluetoothRadio, this test connects the existing
 * executable stand-in for the Swift side (tests/helpers/ble-bridge-driver.ts) over the
 * real loopback socket, authenticated with the device token; the two drivers share one
 * simulated radio world that runs in real time. Pairing goes over Bluetooth too.
 *
 * What this does not cover: a real radio (see docs/sync-ble-transport.md).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { SimWorld, type SimRadio } from '../src/sync/ble/sim.ts';
import { LineDecoder, parseMsg, type BridgeMsg } from '../src/sync/ble/bridge.ts';
import { BridgeDriver } from './helpers/ble-bridge-driver.ts';
import { LocalDevice, kdbMissing, sleep, waitFor } from './helpers/local-device.ts';

/** Runs the simulated air in real time (no waiting for the process to go idle: the backends are other processes). */
function realTime(world: SimWorld): () => Promise<void> {
  (world.clock as unknown as { settle: () => Promise<void> }).settle = async () => undefined;
  let running = true;
  let last = Date.now();
  const loop = (async () => {
    while (running) {
      const now = Date.now();
      await world.clock.advance(now - last);
      last = now;
      await sleep(2);
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}

/** Connects a driver for `radio` to a backend's bridge port, as BLEBridgeClient.swift does. */
async function attachDriver(device: LocalDevice, radio: SimRadio, world: SimWorld): Promise<{ socket: Socket; driver: BridgeDriver }> {
  const socket = connect(device.bleBridgePort!, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.setNoDelay(true);
  socket.write(JSON.stringify({ t: 'auth', token: device.token }) + '\n');
  const driver = new BridgeDriver(radio, world, (m: BridgeMsg) => {
    if (!socket.destroyed) socket.write(JSON.stringify(m) + '\n');
  });
  const dec = new LineDecoder();
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    for (const line of dec.push(chunk)) {
      const m = parseMsg(line);
      if (m && m.t !== 'hello') driver.handle(m);
    }
  });
  return { socket, driver };
}

describe('Bluetooth sync between two local-mode processes, Wi-Fi off', { skip: kdbMissing, timeout: 300_000 }, () => {
  let a: LocalDevice;
  let b: LocalDevice;
  let stopClock: () => Promise<void>;
  const sockets: Socket[] = [];
  const env = { QTASK_BLE_BRIDGE: '1', QTASK_SYNC_LAN: '0' };

  before(async () => {
    a = new LocalDevice({ name: 'Mac A', env });
    b = new LocalDevice({ name: 'Mac B', env });
    await Promise.all([a.start(), b.start()]);
    assert.ok(a.bleBridgePort && b.bleBridgePort, 'both backends opened the Bluetooth bridge');
    const world = new SimWorld({ mtu: 185, bytesPerSec: 60_000, latencyMs: 30, connectMs: 300, advertiseIntervalMs: 200 });
    stopClock = realTime(world);
    for (const [d, name] of [[a, 'A'], [b, 'B']] as const) {
      const { socket } = await attachDriver(d, world.createRadio(name), world);
      sockets.push(socket);
    }
  });

  after(async () => {
    for (const s of sockets) s.destroy();
    await stopClock?.();
    await Promise.allSettled([a?.stop(), b?.stop()]);
  });

  const taskOn = (d: LocalDevice, id: string) => d.api('GET', `/api/tasks/${id}`).then((r) => (r.status === 200 ? r.body.task : null));

  it('reports Bluetooth available but off until the user turns it on', async () => {
    const s = await a.status();
    assert.equal(s.wifi.running, false);
    assert.equal(s.bluetooth.available, true);
    assert.equal(s.bluetooth.enabled, false);
    for (const d of [a, b]) assert.equal((await d.sync('POST', '/bluetooth', { enabled: true })).status, 200);
    await waitFor('radio on through the bridge', async () => (await a.status()).bluetooth.radio === 'on');
  });

  it('pairs over Bluetooth with the QR link and connects', async () => {
    const open = await a.sync('POST', '/pair/open');
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.equal(open.body.link, undefined, 'no Wi-Fi link with Wi-Fi off');
    assert.match(open.body.bleLink, /^qtask:\/\/pairble\?/);
    const join = await b.sync('POST', '/pair/join', { link: open.body.bleLink });
    assert.equal(join.status, 200, JSON.stringify(join.body));
    await waitFor('pairing to finish', async () => (await b.sync('GET', '/pair')).body.pairing.phase === 'paired', 60_000);
    await waitFor(
      'a Bluetooth link on both sides',
      async () => {
        const [sa, sb] = await Promise.all([a.status(), b.status()]);
        return sa.peers[0]?.transport === 'bluetooth' && sb.peers[0]?.transport === 'bluetooth';
      },
      60_000
    );
  });

  it('syncs tasks both ways over Bluetooth', async () => {
    const id = (await a.api('POST', '/api/tasks', { title: 'Over the air' })).body.task._id;
    await waitFor('the task on B', () => taskOn(b, id), 60_000);
    assert.equal((await b.api('PATCH', `/api/tasks/${id}`, { title: 'Back over the air' })).status, 200);
    await waitFor('the edit on A', async () => (await taskOn(a, id))?.title === 'Back over the air', 60_000);
    assert.equal((await a.api('DELETE', `/api/tasks/${id}`)).status, 204);
    await waitFor('the delete on B', async () => (await taskOn(b, id)) === null, 60_000);
    const s = await b.status();
    assert.equal(s.peers[0].lastTransport, 'bluetooth');
  });

  it('turning Bluetooth off drops the link and persists', async () => {
    assert.equal((await b.sync('POST', '/bluetooth', { enabled: false })).status, 200);
    await waitFor('the link to drop', async () => !(await a.status()).peers[0].connected, 30_000);
    const s = await b.status();
    assert.equal(s.bluetooth.enabled, false);
  });
});
