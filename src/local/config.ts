/**
 * Local mode: the Express backend running as a private, single-user service on one
 * device (the Mac app's child process), with no network, no accounts and no cloud.
 *
 * It is switched on by the environment, never by an end user, and is read live (not
 * snapshotted at import) so tests and entry points can toggle it. The contract for
 * everything else that builds on this lives in ./README.md.
 */

import os from 'node:os';
import path from 'node:path';

/** Reported by GET /api/version so clients know which UI to show. */
export type RuntimeMode = 'local' | 'online';

export function isLocalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QTASK_LOCAL === '1' || env.QTASK_LOCAL === 'true';
}

export function runtimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  return isLocalMode(env) ? 'local' : 'online';
}

/** Where a device keeps its data: ~/Library/Application Support/QTask on macOS. */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'QTask');
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'QTask');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'QTask');
}

/**
 * The device's data directory. `QTASK_DATA_DIR` overrides the default; tests and the
 * e2e harness rely on that to keep a run away from the real data.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.QTASK_DATA_DIR?.trim();
  return path.resolve(override ? override : defaultDataDir(process.platform, os.homedir(), env));
}

export interface LocalConfig {
  dataDir: string;
  /** The per-launch secret the app's native side attaches to every request. */
  deviceToken: string;
  /** Always loopback: local mode refuses to listen anywhere else. */
  host: '127.0.0.1';
}

/** Header the native shell puts on every request it forwards to the local server. */
export const DEVICE_TOKEN_HEADER = 'x-qtask-device-token';

/** The minimum length of a device token. The shell generates 32 random bytes. */
export const MIN_DEVICE_TOKEN_LENGTH = 16;

export function resolveLocalConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const deviceToken = env.QTASK_DEVICE_TOKEN ?? '';
  if (deviceToken.length < MIN_DEVICE_TOKEN_LENGTH) {
    throw new Error(
      `QTASK_LOCAL requires QTASK_DEVICE_TOKEN of at least ${MIN_DEVICE_TOKEN_LENGTH} characters ` +
        '(the app generates one per launch)'
    );
  }
  return { dataDir: resolveDataDir(env), deviceToken, host: '127.0.0.1' };
}
