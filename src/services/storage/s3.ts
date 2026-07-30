import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { assertSafeStorageKey, type ObjectStorage, type StoredObject } from './types.js';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint || undefined,
      forcePathStyle: Boolean(config.endpoint),
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            }
          : undefined,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeStorageKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    assertSafeStorageKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        })
      );
      if (!response.Body) return null;
      const bytes = await response.Body.transformToByteArray();
      return {
        body: Buffer.from(bytes),
        contentType: response.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeStorageKey(key);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      })
    );
  }
}
