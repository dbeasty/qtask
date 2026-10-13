/** Small, crash-safe file helpers for the device's private state under the data directory. */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Writes JSON owner-only via a temp file, fsync and rename, then fsyncs the directory:
 * after this resolves the new contents survive a crash or `kill -9`, and a crash during
 * the write leaves the previous file.
 */
export async function writeJsonPrivate(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  const d = await fs.open(dir, 'r');
  try {
    await d.sync();
  } catch {
    // not every file system allows fsync on a directory
  } finally {
    await d.close();
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
