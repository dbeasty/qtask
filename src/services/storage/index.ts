import path from 'node:path';
import { config } from '../../config/index.js';
import { LocalObjectStorage } from './local.js';
import { S3ObjectStorage } from './s3.js';
import type { ObjectStorage } from './types.js';

export {
  assertSafeStorageKey,
  extensionForContentType,
  STORAGE_KEY_PATTERN,
  type ObjectStorage,
  type StoredObject,
} from './types.js';

let storageInstance: ObjectStorage | null = null;

export function createObjectStorage(): ObjectStorage {
  if (config.storage.backend === 's3') {
    const { bucket, region, endpoint, accessKeyId, secretAccessKey } = config.storage.s3;
    if (!bucket || !region) {
      throw new Error('S3_BUCKET and S3_REGION are required when STORAGE_BACKEND=s3');
    }
    return new S3ObjectStorage({ bucket, region, endpoint, accessKeyId, secretAccessKey });
  }
  const localPath = path.resolve(config.storage.localPath);
  return new LocalObjectStorage(localPath);
}

export function getObjectStorage(): ObjectStorage {
  if (!storageInstance) {
    storageInstance = createObjectStorage();
  }
  return storageInstance;
}

/** Test helper — replace the singleton storage backend. */
export function setObjectStorageForTests(storage: ObjectStorage | null): void {
  storageInstance = storage;
}
