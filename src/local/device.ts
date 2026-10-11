/**
 * Device identity and the on-disk layout of a device's data directory.
 *
 * This is the surface later phases (cloud sync, Wi-Fi/Bluetooth peer sync) build on;
 * see ./README.md. Everything here is plain files under the data directory so the
 * Swift shell, tests and other processes can read it without the backend running.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface DeviceIdentity {
  /** Stable for the life of the data directory. A UUID. */
  deviceId: string;
  /** Ed25519 public key, base64 of the SPKI DER encoding. */
  publicKey: string;
  createdAt: string;
  /** Layout/format version of device.json. */
  schema: 1;
}

export interface DataPaths {
  root: string;
  /** device.json: the public identity. */
  deviceFile: string;
  /** device.key: PKCS8 PEM private key, mode 0600. Never leaves the device. */
  deviceKeyFile: string;
  /** secrets.json: session-signing secrets, mode 0600. */
  secretsFile: string;
  /** KDB data root (kdb-service --data-dir). */
  kdbDir: string;
  /** Attachments (storage/local). */
  uploadsDir: string;
  logsDir: string;
}

export function dataPaths(dataDir: string): DataPaths {
  return {
    root: dataDir,
    deviceFile: path.join(dataDir, 'device.json'),
    deviceKeyFile: path.join(dataDir, 'device.key'),
    secretsFile: path.join(dataDir, 'secrets.json'),
    kdbDir: path.join(dataDir, 'kdb'),
    uploadsDir: path.join(dataDir, 'uploads'),
    logsDir: path.join(dataDir, 'logs'),
  };
}

/** Creates the directory tree, owner-only. Safe to call on every launch. */
export function ensureDataDirs(dataDir: string): DataPaths {
  const paths = dataPaths(dataDir);
  for (const dir of [paths.root, paths.kdbDir, paths.uploadsDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(paths.root, 0o700);
  return paths;
}

/** Writes via a temp file + rename so a crash never leaves a half-written key. */
function writePrivate(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function loadOrCreateDeviceIdentity(dataDir: string): DeviceIdentity {
  const paths = ensureDataDirs(dataDir);
  if (existsSync(paths.deviceFile) && existsSync(paths.deviceKeyFile)) {
    const identity = JSON.parse(readFileSync(paths.deviceFile, 'utf8')) as DeviceIdentity;
    // The public key on disk must be the one the private key derives; a mismatch
    // means the two files came from different devices (a bad restore or copy) and
    // continuing would sign as someone else.
    const derived = createPublicKey(createPrivateKey(readFileSync(paths.deviceKeyFile, 'utf8')))
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
    if (derived !== identity.publicKey) {
      throw new Error(`device.json and device.key in ${dataDir} do not belong together`);
    }
    return identity;
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const identity: DeviceIdentity = {
    deviceId: randomUUID(),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    createdAt: new Date().toISOString(),
    schema: 1,
  };
  writePrivate(paths.deviceKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  writePrivate(paths.deviceFile, JSON.stringify(identity, null, 2) + '\n');
  return identity;
}

export interface LocalSecrets {
  jwtSecret: string;
  adminJwtSecret: string;
  mcpOAuthJwtSecret: string;
}

/**
 * Session-signing secrets, generated once and kept with the data, so a session survives
 * a relaunch. They never leave the device and are not part of any sync.
 */
export function loadOrCreateSecrets(dataDir: string): LocalSecrets {
  const paths = ensureDataDirs(dataDir);
  if (existsSync(paths.secretsFile)) {
    return JSON.parse(readFileSync(paths.secretsFile, 'utf8')) as LocalSecrets;
  }
  const secrets: LocalSecrets = {
    jwtSecret: randomBytes(48).toString('base64url'),
    adminJwtSecret: randomBytes(48).toString('base64url'),
    mcpOAuthJwtSecret: randomBytes(48).toString('base64url'),
  };
  writePrivate(paths.secretsFile, JSON.stringify(secrets) + '\n');
  return secrets;
}
