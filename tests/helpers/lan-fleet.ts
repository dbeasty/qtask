import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./lan-worker.ts', import.meta.url));
export const ENGINE_WORKER = fileURLToPath(new URL('./lan-engine-worker.ts', import.meta.url));

export class Device {
  private seq = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  readonly events: any[] = [];
  info!: { nodeId: string; port: number; certFp: string; pid: number };
  proc!: ChildProcess;
  constructor(
    readonly name: string,
    readonly dir: string,
    private readonly worker: string = WORKER,
  ) {}

  async spawn(discoveryPort?: number): Promise<this> {
    this.proc = fork(this.worker, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      this.proc.on('message', (m: any) => {
        if (m.event === 'ready') return resolve();
        if (m.event) return void this.events.push(m);
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error));
        else p.res(m.result);
      });
      this.proc.once('error', reject);
      this.proc.once('exit', (code) => {
        for (const p of this.pending.values()) p.rej(new Error(`worker exited (${code})`));
        this.pending.clear();
      });
    });
    this.info = await this.call('init', { dir: this.dir, name: this.name, discoveryPort });
    return this;
  }

  call<T = any>(cmd: string, args?: unknown): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res, rej });
      this.proc.send({ id, cmd, args });
    });
  }

  kill(): Promise<void> {
    return new Promise((r) => {
      if (this.proc.exitCode !== null || this.proc.signalCode) return r();
      this.proc.once('exit', () => r());
      this.proc.kill('SIGKILL');
    });
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode) return;
    await this.call('stop').catch(() => undefined);
    await new Promise<void>((r) => {
      this.proc.once('exit', () => r());
      this.proc.kill('SIGTERM');
    });
  }
}

export class Fleet {
  devices: Device[] = [];
  constructor(private readonly worker: string = WORKER) {}
  async add(name: string, discoveryPort?: number, dir?: string): Promise<Device> {
    const d = new Device(name, dir ?? (await mkdtemp(join(tmpdir(), `qtask-fleet-${name}-`))), this.worker);
    await d.spawn(discoveryPort);
    this.devices.push(d);
    return d;
  }
  /** Pairs b to a using the QR flow, across processes. */
  async pair(a: Device, b: Device): Promise<void> {
    const { link } = await a.call('openPairing');
    await Promise.all([a.call('awaitPairing'), b.call('pairWith', { link })]);
  }
  async cleanup(): Promise<void> {
    for (const d of this.devices) await d.stop().catch(() => undefined);
    for (const d of this.devices) await rm(d.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
