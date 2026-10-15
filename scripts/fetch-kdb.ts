/**
 * Downloads the released `kdb-service` this checkout is pinned to, for tests and local runs.
 *
 *   npm run kdb:fetch
 *
 * The version is the one `@kdb/client` is installed at (package.json), because the client's
 * handshake refuses a server from another release: one pin, not two that can drift. The binary
 * comes from that release's GitHub assets and is checked against its SHA256SUMS before it is
 * made executable. It lands in `.kdb/<version>/kdb-service` (git-ignored), where
 * tests/helpers/kdbRelease.ts looks for it. Production runs the release's container image
 * instead (ghcr.io/dbeasty/kdb/kdb-service:v<version>); see docs/KDB_MIGRATION.md.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = 'dbeasty/kdb';

/** The @kdb/client version package-lock.json installs, or undefined when it installs none. */
export function pinnedKdbVersion(): string | undefined {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  return lock.packages['node_modules/@kdb/client']?.version;
}

/** The release's tools this repository uses: the server, and kdb-inspect for backups and restores. */
export type KdbTool = 'kdb-service' | 'kdb-inspect';

function assetName(tool: KdbTool = 'kdb-service'): string {
  const os = platform() === 'darwin' ? 'darwin' : platform() === 'linux' ? 'linux' : undefined;
  const cpu = arch() === 'arm64' ? 'arm64' : arch() === 'x64' ? 'amd64' : undefined;
  if (!os || !cpu) throw new Error(`no ${tool} release asset for ${platform()}/${arch()}`);
  return `${tool}-${os}-${cpu}`;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchKdbService(version = pinnedKdbVersion()): Promise<string> {
  return fetchKdbTool('kdb-service', version);
}

/** Downloads one of the release's tools into `.kdb/<version>/<tool>`, checksum-verified. */
export async function fetchKdbTool(tool: KdbTool, version = pinnedKdbVersion()): Promise<string> {
  if (!version) throw new Error('@kdb/client is not in package-lock.json - run npm install');
  const target = join(ROOT, '.kdb', version, tool);
  if (existsSync(target)) return target;

  const name = assetName(tool);
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  const [binary, sums] = await Promise.all([download(`${base}/${name}`), download(`${base}/SHA256SUMS`)]);

  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, file]) => file === name || file?.endsWith(`/${name}`))?.[0];
  if (!expected) throw new Error(`${name} is not listed in v${version}'s SHA256SUMS`);
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual !== expected) throw new Error(`${name} v${version}: sha256 ${actual}, release says ${expected}`);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(`${target}.partial`, binary);
  chmodSync(`${target}.partial`, 0o755);
  renameSync(`${target}.partial`, target);
  return target;
}

if (import.meta.main) {
  console.log(`kdb-service v${pinnedKdbVersion()} at ${await fetchKdbService()}`);
  // kdb-inspect takes and restores backups (deploy/kdb-backup.sh, scripts/kdb-restore-drill.ts).
  if (process.argv.includes('--with-inspect')) console.log(`kdb-inspect v${pinnedKdbVersion()} at ${await fetchKdbTool('kdb-inspect')}`);
}
