import { createHash, randomBytes } from 'node:crypto';
import { McpApiKeyModel } from '../models/index.js';
import type { McpApiKeySummary, McpKeyScope } from '../types/mcp.js';
import { HttpError } from '../utils/httpError.js';

const KEY_PREFIX = 'qtk_';

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function toSummary(doc: {
  _id: unknown;
  name: string;
  prefix: string;
  scope: McpKeyScope;
  createdAt?: Date | null;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
}): McpApiKeySummary {
  return {
    id: String(doc._id),
    name: doc.name,
    prefix: doc.prefix,
    scope: doc.scope,
    createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString(),
    lastUsedAt: doc.lastUsedAt?.toISOString() ?? undefined,
    revokedAt: doc.revokedAt?.toISOString() ?? undefined,
  };
}

export class McpKeyService {
  async createKey(
    userId: string,
    name: string,
    scope: McpKeyScope
  ): Promise<{ key: McpApiKeySummary; secret: string }> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new HttpError(400, 'Key name is required');
    }

    const secret = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const doc = await McpApiKeyModel.create({
      userId,
      name: trimmed,
      prefix: secret.slice(0, 12),
      keyHash: hashKey(secret),
      scope,
    });

    return { key: toSummary(doc), secret };
  }

  async listKeys(userId: string): Promise<McpApiKeySummary[]> {
    const docs = await McpApiKeyModel.find({ userId }).sort({ createdAt: -1 }).lean();
    return docs.map((doc) => toSummary(doc));
  }

  async revokeKey(userId: string, keyId: string): Promise<McpApiKeySummary | null> {
    const doc = await McpApiKeyModel.findOneAndUpdate(
      { _id: keyId, userId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
      { new: true }
    ).lean();
    return doc ? toSummary(doc) : null;
  }

  async authenticate(rawKey: string): Promise<{ userId: string; keyId: string; scope: McpKeyScope } | null> {
    if (!rawKey.startsWith(KEY_PREFIX)) {
      return null;
    }

    const keyHash = hashKey(rawKey);
    const doc = await McpApiKeyModel.findOneAndUpdate(
      { keyHash, revokedAt: { $exists: false } },
      { $set: { lastUsedAt: new Date() } },
      { new: true }
    ).lean();

    if (!doc) {
      return null;
    }

    return {
      userId: doc.userId,
      keyId: String(doc._id),
      scope: doc.scope as McpKeyScope,
    };
  }
}

export const mcpKeyService = new McpKeyService();
