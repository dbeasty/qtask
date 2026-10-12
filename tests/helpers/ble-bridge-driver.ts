/**
 * A stand-in for the Swift side of the Bluetooth bridge: speaks the same JSON protocol
 * (src/sync/ble/bridge.ts) and drives a SimulatedRadio the way
 * client-macos/Sources/QTask/BLE/CoreBluetoothRadio.swift drives CoreBluetooth. It is the
 * executable specification of what the Swift code must do, including the desired-state
 * rule, the write queue and the `acked` credit.
 */

import { BridgeRadio, type BridgeMsg } from '../../src/sync/ble/bridge.ts';
import type { GattLink } from '../../src/sync/ble/radio.ts';
import type { SimRadio, SimWorld } from '../../src/sync/ble/sim.ts';

interface DriverLink {
  id: string;
  link: GattLink & { readInfo?: () => Promise<Uint8Array> };
  queue: Uint8Array[];
  pumping: boolean;
}

export class BridgeDriver {
  private links = new Map<string, DriverLink>();
  private seq = 0;
  private cancelled = new Set<number>();
  private desiredInfo: Buffer | null = null;
  private desiredScan = false;
  /** Largest number of chunks ever waiting in the driver's own queue (the window bounds it). */
  maxQueued = 0;

  constructor(
    private readonly radio: SimRadio,
    private readonly world: SimWorld,
    private readonly toNode: (m: BridgeMsg) => void,
  ) {
    radio.onState((s) => {
      this.toNode({ t: 'state', state: s });
      if (s === 'on') this.applyDesired();
    });
    radio.onDiscovered((d) => this.toNode({ t: 'discovered', device: d.deviceId, rssi: d.rssi ?? 0 }));
    radio.onIncoming((l) => {
      const id = `L${++this.seq}`;
      this.register(id, l);
      this.toNode({ t: 'incoming', link: id, mtu: l.mtu });
    });
    this.toNode({ t: 'state', state: radio.state });
  }

  private applyDesired(): void {
    if (this.desiredInfo) void this.radio.startAdvertising(this.desiredInfo);
    if (this.desiredScan) void this.radio.startScan();
  }

  private register(id: string, link: GattLink): DriverLink {
    const dl: DriverLink = { id, link, queue: [], pumping: false };
    this.links.set(id, dl);
    link.onData((c) => this.toNode({ t: 'data', link: id, data: Buffer.from(c).toString('base64') }));
    link.onClose((e) => {
      this.links.delete(id);
      this.toNode({ t: 'closed', link: id, ...(e ? { error: e.message } : {}) });
    });
    return dl;
  }

  /** A command from the Node side. */
  handle(m: BridgeMsg): void {
    switch (m.t) {
      case 'adv.start':
        this.desiredInfo = Buffer.from(String(m.info), 'base64');
        if (this.radio.state === 'on') void this.radio.startAdvertising(this.desiredInfo);
        return;
      case 'adv.info':
        this.desiredInfo = Buffer.from(String(m.info), 'base64');
        void this.radio.setInfo(this.desiredInfo);
        return;
      case 'adv.stop':
        this.desiredInfo = null;
        void this.radio.stopAdvertising();
        return;
      case 'scan.start':
        this.desiredScan = true;
        if (this.radio.state === 'on') void this.radio.startScan();
        return;
      case 'scan.stop':
        this.desiredScan = false;
        void this.radio.stopScan();
        return;
      case 'connect': {
        const req = m.req as number;
        this.radio.connect(String(m.device), Number(m.timeoutMs)).then(
          (link) => {
            const id = `L${++this.seq}`;
            if (this.cancelled.delete(req)) {
              link.close();
              return;
            }
            this.register(id, link);
            this.toNode({ t: 'connected', req, link: id, mtu: link.mtu });
          },
          (e: Error) => {
            if (!this.cancelled.delete(req)) this.toNode({ t: 'connect.failed', req, error: e.message });
          },
        );
        return;
      }
      case 'connect.cancel':
        this.cancelled.add(m.req as number);
        return;
      case 'info.read': {
        const dl = this.links.get(String(m.link));
        const req = m.req as number;
        if (!dl?.link.readInfo) return void this.toNode({ t: 'info.failed', req, error: 'no such link' });
        dl.link.readInfo().then(
          (d) => this.toNode({ t: 'info', req, data: Buffer.from(d).toString('base64') }),
          (e: Error) => this.toNode({ t: 'info.failed', req, error: e.message }),
        );
        return;
      }
      case 'write': {
        const dl = this.links.get(String(m.link));
        if (!dl) return;
        dl.queue.push(Buffer.from(String(m.data), 'base64'));
        this.maxQueued = Math.max(this.maxQueued, dl.queue.length);
        this.pump(dl);
        return;
      }
      case 'close':
        this.links.get(String(m.link))?.link.close();
        return;
    }
  }

  /** Hands queued chunks to the radio as it accepts them and acks each batch, like CoreBluetooth's ready callback. */
  private pump(dl: DriverLink): void {
    if (dl.pumping) return;
    dl.pumping = true;
    const run = () => {
      let accepted = 0;
      try {
        while (dl.queue.length) {
          if (!dl.link.tryWrite(dl.queue[0]!)) {
            dl.link.onWritable(run);
            break;
          }
          dl.queue.shift();
          accepted++;
        }
      } catch {
        dl.queue.length = 0; // link closed under us
      }
      if (accepted) this.toNode({ t: 'acked', link: dl.id, n: accepted });
      if (!dl.queue.length) dl.pumping = false;
    };
    run();
  }
}

/**
 * A BridgeRadio wired to a BridgeDriver over a virtual-time "socket": every message goes
 * through JSON text (so only JSON-safe data survives) and takes `hopMs` of virtual time.
 */
export function bridged(sim: SimRadio, world: SimWorld, opts: { window?: number; hopMs?: number } = {}): { radio: BridgeRadio; driver: BridgeDriver } {
  const hop = opts.hopMs ?? 1;
  const radio = new BridgeRadio(null, { window: opts.window ?? 8, timers: world.clock });
  const toNodeFns: Array<(m: BridgeMsg) => void> = [];
  const post = (to: (m: BridgeMsg) => void) => (m: BridgeMsg) => {
    const text = JSON.stringify(m);
    world.clock.schedule(world.clock.now() + hop, 'radio', () => to(JSON.parse(text) as BridgeMsg));
  };
  const driver = new BridgeDriver(sim, world, post((m) => radio.feed(m)));
  void toNodeFns;
  radio.attach(post((m) => driver.handle(m)));
  return { radio, driver };
}
