/**
 * The Bluetooth LE radio as the sync code sees it. Everything above this file (tunnel,
 * transport, selector) is plain TypeScript and tested against `SimulatedRadio`
 * (sim.ts); CoreBluetooth (client-macos/Sources/QTask/BLE/) implements the same
 * contract natively and a bridge hands bytes across (see docs/sync-ble-transport.md).
 *
 * The radio is deliberately dumb: it moves chunks of bytes and tells the truth about
 * the link. No pairing and no bonding (so no OS dialog and no encrypted
 * characteristics): the tunnel on top authenticates and encrypts everything.
 *
 * GATT profile (one primary service):
 *
 *   info  (read)                       what this device is; readable by anyone in range
 *   c2h   (write without response)     central -> peripheral
 *   h2c   (notify)                     peripheral -> central
 *
 * Every device runs BOTH roles at once. For one pair, whichever side connected first is
 * the central of that link; the tunnel does not care which.
 */

export const BLE_SERVICE_UUID = '7d1a5b00-9a3c-4c52-8f4e-51a5c0de7a01';
export const BLE_INFO_UUID = '7d1a5b00-9a3c-4c52-8f4e-51a5c0de7a02';
export const BLE_C2H_UUID = '7d1a5b00-9a3c-4c52-8f4e-51a5c0de7a03';
export const BLE_H2C_UUID = '7d1a5b00-9a3c-4c52-8f4e-51a5c0de7a04';

/** ATT overhead of one write / notification: opcode (1) + handle (2). */
export const ATT_OVERHEAD = 3;
/** Smallest legal ATT MTU, and the largest value a characteristic can carry. */
export const ATT_MTU_MIN = 23;
export const ATT_MTU_MAX = 517;

// --- clock ----------------------------------------------------------------------------------

/**
 * Time source. Real timers in production; the simulator supplies a virtual clock so a
 * sync that takes minutes on a 20 KB/s link runs in milliseconds and deterministically.
 */
export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

// --- links ----------------------------------------------------------------------------------

/**
 * One GATT connection, seen from either end. On the central side `write` is a
 * write-without-response to `c2h`; on the peripheral side it is a notification on `h2c`.
 */
export interface GattLink {
  /** Radio-local handle. Not stable: addresses rotate, so never use it to identify a peer. */
  readonly id: string;
  readonly role: 'central' | 'peripheral';
  /** Negotiated ATT MTU. */
  readonly mtu: number;
  /** Largest chunk `tryWrite` accepts: mtu - 3. */
  readonly maxChunk: number;
  /**
   * Hands one chunk (1..maxChunk bytes) to the radio. Returns false when the radio's
   * queue is full; the chunk was NOT taken and the caller waits for `onWritable`.
   * (CoreBluetooth: `canSendWriteWithoutResponse` / `updateValue` returning false and
   * `peripheralManagerIsReady`.) Throws if the link is closed.
   */
  tryWrite(chunk: Uint8Array): boolean;
  /** One-shot. Fires when a previously refused `tryWrite` would now succeed, and also when the link closes (so a blocked writer wakes up and its next `tryWrite` throws). */
  onWritable(handler: () => void): void;
  /** Chunks arrive in order, exactly as written by the other end's `tryWrite`. */
  onData(handler: (chunk: Uint8Array) => void): void;
  /** Fires once, when the link is gone (range, remote close, local close, radio off). */
  onClose(handler: (reason?: Error) => void): void;
  close(): void;
}

export interface CentralLink extends GattLink {
  readonly role: 'central';
  /** Reads the `info` characteristic. */
  readInfo(): Promise<Uint8Array>;
}

export interface PeripheralLink extends GattLink {
  readonly role: 'peripheral';
}

export interface Discovery {
  /** Radio-local, may change between sightings of the same device (address rotation). */
  deviceId: string;
  rssi?: number;
}

export type RadioState = 'on' | 'off' | 'unauthorized' | 'unsupported' | 'unknown';

export interface BleRadio {
  readonly state: RadioState;
  onState(handler: (state: RadioState) => void): void;

  // peripheral role
  /** Advertises the service UUID only; `info` is what a connected central reads. Replaces earlier info. */
  startAdvertising(info: Uint8Array): Promise<void>;
  /** Changes the `info` value without a new advertisement (e.g. pairing window opened). */
  setInfo(info: Uint8Array): Promise<void>;
  stopAdvertising(): Promise<void>;
  /** A central connected and subscribed to `h2c`: the link is ready for data. */
  onIncoming(handler: (link: PeripheralLink) => void): void;

  // central role
  /** Scans for the service UUID. Each device is reported once per scan session. */
  startScan(): Promise<void>;
  stopScan(): Promise<void>;
  onDiscovered(handler: (d: Discovery) => void): void;
  /**
   * Connects, discovers the service, negotiates the MTU and subscribes to `h2c`.
   * Rejects after `timeoutMs` (CoreBluetooth never times out on its own) or if the
   * device id is unknown to the stack.
   */
  connect(deviceId: string, timeoutMs: number): Promise<CentralLink>;
}

// --- helpers ----------------------------------------------------------------------------------

/**
 * Splits `bytes` into link-sized chunks and writes them in order, waiting for the
 * radio's backpressure signal between chunks. Callers serialise whole records
 * themselves (see `SerialWriter`), so chunks of two records never interleave.
 */
export async function writeChunked(link: GattLink, bytes: Uint8Array, isClosed: () => boolean = () => false): Promise<number> {
  const max = link.maxChunk;
  let chunks = 0;
  for (let off = 0; off < bytes.length; ) {
    const end = Math.min(off + max, bytes.length);
    const chunk = bytes.subarray(off, end);
    while (!link.tryWrite(chunk)) {
      if (isClosed()) throw new Error('link closed');
      await new Promise<void>((resolve) => link.onWritable(resolve));
    }
    off = end;
    chunks++;
  }
  return chunks;
}

// --- info characteristic ----------------------------------------------------------------------

export const INFO_VERSION = 1;
export const INFO_FLAG_PAIRING = 0x01;

export interface BleInfo {
  version: number;
  /** The device's LAN identity node id (32 hex chars): the stable name of this device. */
  nodeId: string;
  /** First 8 bytes of SHA-256("qtask-ble-info" || SPKI), hex. A cheap early check before the handshake. */
  keyTag: string;
  /** Pairing window open on this device. */
  pairing: boolean;
  /** Device name; only present while a pairing window is open. */
  name?: string;
}

/** info = version(1) | flags(1) | nodeId(16) | keyTag(8) | [name utf8, <= 24 bytes]. */
export function encodeInfo(i: Omit<BleInfo, 'version'>): Buffer {
  const name = i.pairing && i.name ? Buffer.from(i.name, 'utf8').subarray(0, 24) : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([INFO_VERSION, i.pairing ? INFO_FLAG_PAIRING : 0]),
    Buffer.from(i.nodeId, 'hex'),
    Buffer.from(i.keyTag, 'hex'),
    name,
  ]);
}

/** Never throws; returns null for anything that is not a well-formed info value. */
export function decodeInfo(raw: Uint8Array): BleInfo | null {
  if (!(raw instanceof Uint8Array) || raw.length < 26 || raw.length > 26 + 24) return null;
  const b = Buffer.from(raw);
  if (b[0] !== INFO_VERSION) return null;
  const flags = b[1]!;
  if (flags & ~INFO_FLAG_PAIRING) return null;
  const pairing = (flags & INFO_FLAG_PAIRING) !== 0;
  if (!pairing && b.length !== 26) return null;
  let name: string | undefined;
  if (b.length > 26) {
    const s = b.subarray(26).toString('utf8');
    if (s.includes('�')) return null;
    name = s;
  }
  return { version: b[0]!, nodeId: b.subarray(2, 18).toString('hex'), keyTag: b.subarray(18, 26).toString('hex'), pairing, name };
}
