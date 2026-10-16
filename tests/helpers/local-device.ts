/**
 * A local-mode device for multi-process tests and measurements: its own kdb-service and
 * its own backend process (src/local/entry.ts, exactly what the Mac app runs), each with a
 * private data directory. Talks to the backend over HTTP with the device token, the way
 * the app's bridge does.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CLIENT_MODULE, SERVICE_BIN, kdbUnavailable } from './kdbRelease.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');
// The released kdb-service and @limidus/kdb-client this checkout pins (see kdbRelease.ts); the
// KDB_SERVICE_BIN / KDB_CLIENT_MODULE overrides still apply there.
export const KDB_SERVICE_BIN = SERVICE_BIN;
export const KDB_CLIENT_MODULE = CLIENT_MODULE;
const NAMESPACE = 'qtask/docs';

export const kdbMissing = kdbUnavailable;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(port, '127.0.0.1');
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`port ${port} never opened`);
    await sleep(50);
  }
}

export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs = 20_000,
  everyMs = 50
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`);
    await sleep(everyMs);
  }
}

export interface DeviceOptions {
  name: string;
  /** Private mDNS port shared by the devices of one test (keeps off the system responder). */
  mdnsPort?: number;
  env?: Record<string, string>;
  dataDir?: string;
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export class LocalDevice {
  readonly name: string;
  readonly dataDir: string;
  readonly token = randomBytes(24).toString('hex');
  kdbPort = 0;
  port = 0;
  bleBridgePort?: number;
  deviceId = '';
  node?: ChildProcess;
  kdb?: ChildProcess;
  private session?: string;
  private nodeExit?: Promise<void>;
  output = '';
  private readonly ownsDir: boolean;

  constructor(private readonly o: DeviceOptions) {
    this.name = o.name;
    this.ownsDir = !o.dataDir;
    this.dataDir = o.dataDir ?? mkdtempSync(path.join(os.tmpdir(), `qtask-dev-${o.name}-`));
  }

  async startKdb(): Promise<void> {
    if (this.kdb && this.kdb.exitCode === null) return;
    this.kdbPort = await freePort();
    this.kdb = spawn(
      KDB_SERVICE_BIN,
      [
        '--data-dir', path.join(this.dataDir, 'kdb'),
        '--namespace', NAMESPACE,
        '--sql-addr', `tcp://127.0.0.1:${this.kdbPort}?bind=true`,
        '--peer-addr', '',
        '--stream-addr', '',
        '--log-level', 'error',
      ],
      { stdio: 'ignore' }
    );
    await waitForPort(this.kdbPort);
  }

  /** Starts (or restarts) the backend; resolves once it printed its ready line. */
  async start(): Promise<void> {
    await this.startKdb();
    this.session = undefined;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? os.homedir(),
      TMPDIR: os.tmpdir(),
      NODE_ENV: 'production',
      NODE_NO_WARNINGS: '1',
      QTASK_LOCAL: '1',
      QTASK_DEVICE_TOKEN: this.token,
      QTASK_DATA_DIR: this.dataDir,
      QTASK_DEVICE_NAME: this.name,
      KDB_ADDR: `tcp://127.0.0.1:${this.kdbPort}`,
      KDB_NAMESPACE_PREFIX: NAMESPACE,
      KDB_CLIENT_MODULE,
      QTASK_SYNC_ADVERTISE_HOST: '127.0.0.1',
      LOG_LEVEL: process.env.DEVICE_LOG_LEVEL ?? 'warn',
      ...(this.o.mdnsPort ? { QTASK_SYNC_MDNS_PORT: String(this.o.mdnsPort), QTASK_SYNC_MDNS_IFACES: '127.0.0.1' } : { QTASK_SYNC_MDNS: '0' }),
      ...this.o.env,
    };
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/local/entry.ts')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.node = child;
    this.output = '';
    this.nodeExit = new Promise((r) => child.once('exit', () => r()));
    const ready = await new Promise<{ port: number; deviceId: string; bleBridgePort?: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} did not become ready:\n${this.output.slice(-3000)}`)), 60_000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        this.output += text;
        if (this.output.length > 200_000) this.output = this.output.slice(-100_000);
        const line = this.output.split('\n').find((l) => l.startsWith('QTASK_READY '));
        if (line) {
          clearTimeout(timer);
          child.stdout!.off('data', onData);
          child.stdout!.on('data', (c: Buffer) => (this.output += c.toString()));
          resolve(JSON.parse(line.slice('QTASK_READY '.length)));
        }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', (c: Buffer) => (this.output += c.toString()));
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`${this.name} exited (${code}) before ready:\n${this.output.slice(-3000)}`));
      });
    });
    this.port = ready.port;
    this.deviceId = ready.deviceId;
    this.bleBridgePort = ready.bleBridgePort;
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async token_(): Promise<string> {
    if (!this.session) {
      const r = await fetch(`${this.base}/api/auth/local-session`, { method: 'POST', headers: { 'x-qtask-device-token': this.token } });
      if (!r.ok) throw new Error(`${this.name}: local-session ${r.status}`);
      this.session = ((await r.json()) as { token: string }).token;
    }
    return this.session;
  }

  /** Forgets the session (after the owner changed). */
  resetSession(): void {
    this.session = undefined;
  }

  async api<T = any>(method: string, p: string, body?: unknown): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { 'x-qtask-device-token': this.token, authorization: `Bearer ${await this.token_()}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(this.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }

  /** /api/local-sync with only the device token (what the native app does). */
  async sync<T = any>(method: string, p: string, body?: unknown): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { 'x-qtask-device-token': this.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${this.base}/api/local-sync${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }

  async status(): Promise<any> {
    const r = await this.sync('GET', '/status');
    if (r.status !== 200) throw new Error(`${this.name}: status ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  async tasks(): Promise<Array<Record<string, any>>> {
    const r = await this.api('GET', '/api/tasks?limit=1000');
    if (r.status !== 200) throw new Error(`${this.name}: tasks ${r.status}`);
    return r.body.tasks;
  }

  async projects(): Promise<Array<Record<string, any>>> {
    const r = await this.api('GET', '/api/projects');
    if (r.status !== 200) throw new Error(`${this.name}: projects ${r.status}`);
    return r.body.projects;
  }

  /** SIGKILL the backend only (the store keeps running, as when the Node child crashes). */
  async kill9(): Promise<void> {
    this.node?.kill('SIGKILL');
    await this.nodeExit;
  }

  async stopNode(): Promise<void> {
    if (!this.node || this.node.exitCode !== null) return;
    this.node.kill('SIGTERM');
    await Promise.race([this.nodeExit, sleep(15_000)]);
    if (this.node.exitCode === null) this.node.kill('SIGKILL');
  }

  async stop({ keepData = false } = {}): Promise<void> {
    await this.stopNode();
    this.kdb?.kill('SIGTERM');
    if (!keepData && this.ownsDir) rmSync(this.dataDir, { recursive: true, force: true });
  }
}

/** Opens a pairing on `inviter` and joins it from `joiner` with the QR link; waits for both links. */
export async function pairDevices(inviter: LocalDevice, joiner: LocalDevice): Promise<void> {
  const open = await inviter.sync('POST', '/pair/open');
  if (open.status !== 200) throw new Error(`pair/open ${open.status} ${JSON.stringify(open.body)}`);
  const link = open.body.link ?? open.body.bleLink;
  const join = await joiner.sync('POST', '/pair/join', { link });
  if (join.status !== 200 || join.body.phase !== 'paired') throw new Error(`pair/join ${join.status} ${JSON.stringify(join.body)}`);
  await waitFor('both devices connected', async () => {
    const [a, b] = await Promise.all([inviter.status(), joiner.status()]);
    return a.peers.some((p: any) => p.connected) && b.peers.some((p: any) => p.connected);
  }, 30_000);
}
