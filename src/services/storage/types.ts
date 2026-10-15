export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface ObjectStorage {
  /** Stores `body` under `key`, replacing whatever was there. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** The object, or null when there is none under `key`. */
  get(key: string): Promise<StoredObject | null>;
  /** Removes the object. Removing a key that holds nothing is not an error. */
  delete(key: string): Promise<void>;
  /** Releases whatever connection the backend holds. Optional: local and S3 hold none to close. */
  close?(): Promise<void>;
}

/**
 * Stored bytes did not match their content hash: the copy this backend holds is damaged.
 *
 * Raised, never turned into "not found": a caller that treated a damaged file as a missing one
 * would quietly lose it (the feedback vision queue, for one, drops attachments it cannot find).
 * Retrying the same backend will not help; the copy has to be restored or repaired.
 */
export class StorageIntegrityError extends Error {
  readonly code = 'INTEGRITY' as const;
  constructor(
    readonly key: string,
    options?: { cause?: unknown }
  ) {
    super(`Stored object ${key} failed its integrity check`, options);
    this.name = 'StorageIntegrityError';
  }
}

/** Safe keys: feedback/{uuid}.{png|jpg|jpeg|webp} */
export const STORAGE_KEY_PATTERN = /^feedback\/[0-9a-f-]+\.(png|jpe?g|webp)$/i;

export function assertSafeStorageKey(key: string): void {
  if (!STORAGE_KEY_PATTERN.test(key)) {
    throw new Error('Invalid storage key');
  }
}

export function extensionForContentType(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      throw new Error(`Unsupported content type: ${contentType}`);
  }
}
