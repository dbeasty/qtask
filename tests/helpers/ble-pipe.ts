/**
 * Two GattLinks wired back to back in memory, with an interceptor per direction, for the
 * tunnel's tests (tamper, replay, reorder, truncation, observing what a side puts on the
 * air). Deliveries are scheduled on the virtual clock, so a test drives time with
 * `clock.until(...)` like everywhere else.
 */

import type { GattLink } from '../../src/sync/ble/radio.ts';
import { SimClock } from '../../src/sync/ble/sim.ts';

export type Tap = (chunk: Buffer, index: number) => Buffer[] | null;

export interface PipeEnd extends GattLink {
  sent: Buffer[];
  received: Buffer[];
}

class End implements PipeEnd {
  readonly sent: Buffer[] = [];
  readonly received: Buffer[] = [];
  other!: End;
  private dataHandler: ((c: Uint8Array) => void) | null = null;
  private early: Uint8Array[] = [];
  private closeHandlers: Array<(e?: Error) => void> = [];
  private writable: Array<() => void> = [];
  private closedFlag = false;
  tap: Tap | null = null;
  count = 0;
  readonly maxChunk: number;
  constructor(
    readonly id: string,
    readonly role: 'central' | 'peripheral',
    readonly mtu: number,
    private readonly clock: SimClock,
    private readonly latencyMs: number,
  ) {
    this.maxChunk = mtu - 3;
  }
  tryWrite(chunk: Uint8Array): boolean {
    if (this.closedFlag) throw new Error('link closed');
    if (chunk.length > this.maxChunk || chunk.length < 1) throw new Error(`bad chunk size ${chunk.length}`);
    const c = Buffer.from(chunk);
    this.sent.push(c);
    const out = this.tap ? this.tap(c, this.count++) : [c];
    for (const piece of out ?? []) {
      this.clock.schedule(this.clock.now() + this.latencyMs, 'radio', () => this.other.receive(piece));
    }
    return true;
  }
  onWritable(h: () => void): void {
    if (this.closedFlag) queueMicrotask(h);
    else this.writable.push(h);
  }
  onData(h: (c: Uint8Array) => void): void {
    this.dataHandler = h;
    for (const c of this.early.splice(0)) h(c);
  }
  receive(c: Buffer): void {
    if (this.closedFlag) return;
    this.received.push(c);
    if (this.dataHandler) this.dataHandler(c);
    else this.early.push(c);
  }
  onClose(h: (e?: Error) => void): void {
    if (this.closedFlag) h();
    else this.closeHandlers.push(h);
  }
  close(): void {
    this.finish();
    this.clock.schedule(this.clock.now() + this.latencyMs, 'radio', () => this.other.finish());
  }
  finish(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const w of this.writable.splice(0)) w();
    for (const h of this.closeHandlers.splice(0)) h();
  }
  get closed(): boolean {
    return this.closedFlag;
  }
}

export function memoryLinks(clock: SimClock, opts: { mtu?: number; latencyMs?: number } = {}): { central: PipeEnd & { tap: Tap | null }; peripheral: PipeEnd & { tap: Tap | null } } {
  const mtu = opts.mtu ?? 185;
  const lat = opts.latencyMs ?? 5;
  const c = new End('central', 'central', mtu, clock, lat);
  const p = new End('peripheral', 'peripheral', mtu, clock, lat);
  c.other = p;
  p.other = c;
  return { central: c, peripheral: p };
}
