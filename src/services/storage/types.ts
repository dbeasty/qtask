export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
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
