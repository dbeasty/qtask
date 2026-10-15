/**
 * Docker plumbing for the database benchmark: the two database containers, their resource
 * limits, data volumes (and pristine snapshots of them), stats sampling and on-disk size.
 *
 * Everything the harness starts is named `qtask-bench-*` and only those are ever stopped or
 * removed, so it cannot touch containers it did not create.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync, renameSync, copyFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const ROOT = resolve(import.meta.dirname, '../..');

export const PREFIX = 'qtask-bench';
export const HELPER_IMAGE = 'alpine:3.20';
export const MONGO_IMAGE = 'mongo:7';

/** The limits every database container gets. memory-swap = memory, so no swap at all. */
export interface Limits {
  cpus: number;
  memory: string;
}

export const DEFAULT_LIMITS: Limits = { cpus: 2, memory: '4g' };

export async function docker(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await run('docker', args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 600_000 });
  return stdout.trim();
}

export async function dockerQuiet(args: string[]): Promise<string | null> {
  try {
    return await docker(args);
  } catch {
    return null;
  }
}

export async function engineInfo(): Promise<{ arch: string; ncpu: number; memBytes: number; serverVersion: string; os: string }> {
  const raw = await docker(['info', '--format', '{{json .}}']);
  const info = JSON.parse(raw) as { Architecture: string; NCPU: number; MemTotal: number; ServerVersion: string; OperatingSystem: string };
  return { arch: info.Architecture, ncpu: info.NCPU, memBytes: info.MemTotal, serverVersion: info.ServerVersion, os: info.OperatingSystem };
}

function goArch(dockerArch: string): 'arm64' | 'amd64' {
  if (dockerArch === 'aarch64' || dockerArch === 'arm64') return 'arm64';
  if (dockerArch === 'x86_64' || dockerArch === 'amd64') return 'amd64';
  throw new Error(`unsupported docker architecture ${dockerArch}`);
}

export async function imageExists(image: string): Promise<boolean> {
  return (await dockerQuiet(['image', 'inspect', image, '--format', '{{.Id}}'])) !== null;
}

export async function ensureImage(image: string): Promise<void> {
  if (await imageExists(image)) return;
  console.log(`pulling ${image} ...`);
  await docker(['pull', image]);
}

export async function imageDigest(image: string): Promise<string> {
  const digests = await dockerQuiet(['image', 'inspect', image, '--format', '{{json .RepoDigests}}']);
  const id = await dockerQuiet(['image', 'inspect', image, '--format', '{{.Id}}']);
  const list = digests ? (JSON.parse(digests) as string[]) : [];
  return list[0] ?? id ?? 'unknown';
}

/**
 * The kdb-service image to run.
 *
 * The published image (ghcr.io/dbeasty/kdb/kdb-service:v<version>) is linux/amd64 only. On an
 * arm64 Docker engine (Apple silicon) it would run under emulation, which would measure the
 * emulator rather than KDB and make any comparison with a native mongo:7 meaningless. So on a
 * non-amd64 engine the harness builds an equivalent image locally: same base (alpine 3.20), same
 * user (kdb, uid 10001), same entrypoint, data volume and ports as the published one, with the
 * same release's checksum-verified `kdb-service-linux-<arch>` binary in it.
 */
export async function ensureKdbImage(version: string): Promise<{ image: string; source: string }> {
  const official = `ghcr.io/dbeasty/kdb/kdb-service:v${version}`;
  const { arch } = await engineInfo();
  const cpu = goArch(arch);
  if (cpu === 'amd64') {
    await ensureImage(official);
    return { image: official, source: `published image ${official}` };
  }
  const local = `${PREFIX}/kdb-service:v${version}-${cpu}`;
  const asset = `kdb-service-linux-${cpu}`;
  if (await imageExists(local)) {
    return { image: local, source: `local build of ${official} for linux/${cpu} from release asset ${asset}` };
  }
  const binary = await fetchReleaseAsset(version, asset);
  const context = join(ROOT, '.kdb', version, `image-linux-${cpu}`);
  mkdirSync(context, { recursive: true });
  copyFileSync(binary, join(context, 'kdb-service'));
  chmodSync(join(context, 'kdb-service'), 0o755);
  await ensureImage(HELPER_IMAGE);
  console.log(`building ${local} from ${asset} ...`);
  await docker(['build', '-t', local, '-f', join(ROOT, 'bench/docker/kdb-service.Dockerfile'), context]);
  return { image: local, source: `local build of ${official} for linux/${cpu} from release asset ${asset}` };
}

/** Downloads one asset of the KDB release, checked against the release's SHA256SUMS. */
async function fetchReleaseAsset(version: string, name: string): Promise<string> {
  const target = join(ROOT, '.kdb', version, name);
  if (existsSync(target)) return target;
  const base = `https://github.com/dbeasty/kdb/releases/download/v${version}`;
  const get = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  console.log(`downloading ${name} v${version} ...`);
  const [binary, sums] = await Promise.all([get(`${base}/${name}`), get(`${base}/SHA256SUMS`)]);
  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, file]) => file === name || file?.endsWith(`/${name}`))?.[0];
  if (!expected) throw new Error(`${name} is not listed in v${version}'s SHA256SUMS`);
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual !== expected) throw new Error(`${name} v${version}: sha256 ${actual}, release says ${expected}`);
  mkdirSync(join(ROOT, '.kdb', version), { recursive: true });
  writeFileSync(`${target}.partial`, binary);
  chmodSync(`${target}.partial`, 0o755);
  renameSync(`${target}.partial`, target);
  return target;
}

// --- containers -------------------------------------------------------------------------------

export interface ContainerSpec {
  name: string;
  image: string;
  volume: string;
  mountPath: string;
  ports: Array<[host: number, container: number]>;
  args: string[];
  limits: Limits;
}

export async function removeContainer(name: string): Promise<void> {
  if (!name.startsWith(PREFIX)) throw new Error(`refusing to remove ${name}: not a ${PREFIX} container`);
  await dockerQuiet(['rm', '-f', name]);
}

export async function startContainer(spec: ContainerSpec): Promise<void> {
  await removeContainer(spec.name);
  const args = [
    'run', '-d', '--name', spec.name,
    '--cpus', String(spec.limits.cpus),
    '--memory', spec.limits.memory,
    '--memory-swap', spec.limits.memory,
    '-v', `${spec.volume}:${spec.mountPath}`,
    '--label', `${PREFIX}=1`,
  ];
  for (const [host, container] of spec.ports) args.push('-p', `127.0.0.1:${host}:${container}`);
  args.push(spec.image, ...spec.args);
  await docker(args);
}

/** Stops gracefully, so both databases flush and close their files before a snapshot. */
export async function stopContainer(name: string, timeoutSec = 120): Promise<void> {
  if (!name.startsWith(PREFIX)) throw new Error(`refusing to stop ${name}: not a ${PREFIX} container`);
  await dockerQuiet(['stop', '-t', String(timeoutSec), name]);
}

export async function startExisting(name: string): Promise<void> {
  await docker(['start', name]);
}

export interface AppliedLimits {
  nanoCpus: number;
  cpus: number;
  memoryBytes: number;
  memorySwapBytes: number;
  oomKilled: boolean;
  image: string;
  args: string[];
}

export async function inspectLimits(name: string): Promise<AppliedLimits> {
  const raw = JSON.parse(await docker(['inspect', name]))[0] as {
    HostConfig: { NanoCpus: number; Memory: number; MemorySwap: number };
    State: { OOMKilled: boolean };
    Config: { Image: string; Cmd: string[] | null };
    Args: string[];
  };
  return {
    nanoCpus: raw.HostConfig.NanoCpus,
    cpus: raw.HostConfig.NanoCpus / 1e9,
    memoryBytes: raw.HostConfig.Memory,
    memorySwapBytes: raw.HostConfig.MemorySwap,
    oomKilled: raw.State.OOMKilled,
    image: raw.Config.Image,
    args: raw.Args,
  };
}

export async function containerLogs(name: string, tail = 40): Promise<string> {
  try {
    const { stdout, stderr } = await run('docker', ['logs', '--tail', String(tail), name], { maxBuffer: 16 * 1024 * 1024 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    return String((error as Error).message);
  }
}

export async function waitForTcp(port: number, timeoutMs = 120_000): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const open = await new Promise<boolean>((done) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => done(false));
    });
    if (open) return performance.now() - started;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`port ${port} did not open within ${timeoutMs} ms`);
}

export async function waitForHttpOk(url: string, timeoutMs = 120_000): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return performance.now() - started;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${url} was not ready within ${timeoutMs} ms`);
}

// --- volumes ----------------------------------------------------------------------------------

export async function removeVolume(name: string): Promise<void> {
  if (!name.startsWith(PREFIX)) throw new Error(`refusing to remove volume ${name}`);
  await dockerQuiet(['volume', 'rm', '-f', name]);
}

export async function createVolume(name: string): Promise<void> {
  if (!name.startsWith(PREFIX)) throw new Error(`refusing to create volume ${name}`);
  await docker(['volume', 'create', '--label', `${PREFIX}=1`, name]);
}

export async function volumeExists(name: string): Promise<boolean> {
  return (await dockerQuiet(['volume', 'inspect', name])) !== null;
}

/** Copies a volume's content wholesale (ownership included). Both containers must be stopped. */
export async function copyVolume(from: string, to: string): Promise<void> {
  await ensureImage(HELPER_IMAGE);
  await removeVolume(to);
  await createVolume(to);
  await docker(['run', '--rm', '-v', `${from}:/from:ro`, '-v', `${to}:/to`, HELPER_IMAGE, 'sh', '-c', 'cp -a /from/. /to/']);
}

/** Bytes on disk (du, 1 KiB blocks) of a volume. */
export async function volumeBytes(name: string): Promise<number> {
  await ensureImage(HELPER_IMAGE);
  const out = await docker(['run', '--rm', '-v', `${name}:/d:ro`, HELPER_IMAGE, 'du', '-sk', '/d']);
  return Number(out.split(/\s+/)[0]) * 1024;
}

/**
 * Synchronous-write latency of a volume: `dd oflag=dsync` of 4 KiB blocks (GNU dd from the mongo
 * image, which has it). Every durable commit - KDB --durability sync, a MongoDB j:true write -
 * waits for at least one of these, so this is the floor under their write latency here. On
 * Docker Desktop it is the VM's virtual disk, not the Mac's SSD directly.
 */
export async function fsyncProbe(volume: string, image: string, blocks = 20): Promise<{ blocks: number; seconds: number; msPerSync: number } | { error: string }> {
  try {
    const { stderr } = await run('docker', ['run', '--rm', '-v', `${volume}:/d`, '--entrypoint', 'sh', image, '-c',
      `dd if=/dev/zero of=/d/.fsync-probe bs=4k count=${blocks} oflag=dsync; rm -f /d/.fsync-probe`], { timeout: 300_000 });
    const match = /copied, ([\d.]+) s/.exec(stderr);
    if (!match) return { error: stderr.trim().slice(0, 200) };
    const seconds = Number(match[1]);
    return { blocks, seconds, msPerSync: (seconds * 1000) / blocks };
  } catch (error) {
    return { error: String((error as Error).message).slice(0, 200) };
  }
}

/** Drops the VM's page cache so a cold start is cold. Needs a privileged helper; best effort. */
export async function dropCaches(): Promise<boolean> {
  return (await dockerQuiet(['run', '--rm', '--privileged', HELPER_IMAGE, 'sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches'])) !== null;
}

// --- stats ------------------------------------------------------------------------------------

export interface StatsSample {
  t: number;
  cpuPct: number;
  memBytes: number;
}

export interface StatsSummary {
  samples: number;
  cpuPctAvg: number;
  cpuPctMax: number;
  memBytesAvg: number;
  memBytesMax: number;
}

function parseBytes(text: string): number {
  const match = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(text.trim());
  if (!match) return NaN;
  const value = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const scale: Record<string, number> = {
    B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
  };
  return value * (scale[unit] ?? NaN);
}

/**
 * Streams `docker stats` for one container (about one sample a second). CPU% is of one core,
 * so a container limited to 2 CPUs tops out near 200%.
 */
export class StatsSampler {
  private child?: ChildProcess;
  private readonly samples: StatsSample[] = [];
  private buffer = '';

  constructor(private readonly container: string) {}

  start(): void {
    this.child = spawn('docker', ['stats', '--format', '{{json .}}', this.container], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        // docker stats clears the screen between frames even when not on a tty.
        const line = this.buffer.slice(0, index).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line.startsWith('{')) continue;
        try {
          const row = JSON.parse(line) as { CPUPerc: string; MemUsage: string };
          const cpuPct = Number(row.CPUPerc.replace('%', ''));
          const memBytes = parseBytes(row.MemUsage.split('/')[0] ?? '');
          if (Number.isFinite(cpuPct) && Number.isFinite(memBytes)) this.samples.push({ t: Date.now(), cpuPct, memBytes });
        } catch {
          // partial frame
        }
      }
    });
  }

  /** Discards what was sampled so far (e.g. the warmup). */
  reset(): void {
    this.samples.length = 0;
  }

  stop(): StatsSummary {
    this.child?.kill('SIGTERM');
    this.child = undefined;
    // The first frame of a fresh `docker stats` has no previous reading to diff against.
    const rows = this.samples.length > 2 ? this.samples.slice(1) : this.samples;
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      samples: rows.length,
      cpuPctAvg: avg(rows.map((s) => s.cpuPct)),
      cpuPctMax: Math.max(0, ...rows.map((s) => s.cpuPct)),
      memBytesAvg: avg(rows.map((s) => s.memBytes)),
      memBytesMax: Math.max(0, ...rows.map((s) => s.memBytes)),
    };
  }
}
