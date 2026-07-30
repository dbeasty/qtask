import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafeStorageKey, type ObjectStorage, type StoredObject } from './types.js';

export class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly rootPath: string) {}

  private resolvePath(key: string): string {
    assertSafeStorageKey(key);
    const resolvedRoot = path.resolve(this.rootPath);
    const resolved = path.resolve(resolvedRoot, key);
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
      throw new Error('Invalid storage key');
    }
    return resolved;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const filePath = this.resolvePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
    await fs.writeFile(`${filePath}.meta.json`, JSON.stringify({ contentType }), 'utf8');
  }

  async get(key: string): Promise<StoredObject | null> {
    const filePath = this.resolvePath(key);
    try {
      const [body, metaRaw] = await Promise.all([
        fs.readFile(filePath),
        fs.readFile(`${filePath}.meta.json`, 'utf8'),
      ]);
      const meta = JSON.parse(metaRaw) as { contentType?: string };
      return { body, contentType: meta.contentType ?? 'application/octet-stream' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    await Promise.all([
      fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      }),
      fs.unlink(`${filePath}.meta.json`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      }),
    ]);
  }
}
