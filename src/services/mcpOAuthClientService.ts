import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { McpOAuthClientModel } from '../models/index.js';
import type { McpOAuthClientSource, McpOAuthClientSummary } from '../types/mcp.js';
import { HttpError } from '../utils/httpError.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcpOAuthClient');

const CLIENT_ID_PREFIX = 'qto_';
const CLIENT_SECRET_PREFIX = 'qto_sec_';

export interface ResolvedOAuthClient {
  clientId: string;
  name: string;
  source: McpOAuthClientSource;
  redirectUris: string[];
  clientSecretHash?: string;
  userId?: string;
  revokedAt?: Date | null;
}

interface ClientMetadataDocument {
  client_id?: string;
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toSummary(doc: {
  _id: unknown;
  clientId: string;
  name: string;
  source: McpOAuthClientSource;
  createdAt?: Date | null;
  revokedAt?: Date | null;
}): McpOAuthClientSummary {
  return {
    id: String(doc._id),
    clientId: doc.clientId,
    name: doc.name,
    source: doc.source,
    createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString(),
    revokedAt: doc.revokedAt?.toISOString(),
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isUrlFormattedClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.pathname !== '/';
  } catch {
    return false;
  }
}

async function fetchClientMetadataDocument(clientIdUrl: string): Promise<ClientMetadataDocument> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(clientIdUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new HttpError(400, 'Could not fetch OAuth client metadata document');
    }
    const doc = (await response.json()) as ClientMetadataDocument;
    if (doc.client_id !== clientIdUrl) {
      throw new HttpError(400, 'OAuth client metadata client_id mismatch');
    }
    if (!doc.client_name || !Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) {
      throw new HttpError(400, 'Invalid OAuth client metadata document');
    }
    return doc;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    log.warn('CIMD fetch failed', { clientIdUrl, error: String(error) });
    throw new HttpError(400, 'Could not fetch OAuth client metadata document');
  } finally {
    clearTimeout(timeout);
  }
}

export class McpOAuthClientService {
  async createRegisteredClient(
    userId: string,
    name: string
  ): Promise<{ client: McpOAuthClientSummary; clientId: string; clientSecret: string }> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new HttpError(400, 'Client name is required');
    }

    const clientId = `${CLIENT_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
    const clientSecret = `${CLIENT_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;

    const doc = await McpOAuthClientModel.create({
      clientId,
      clientSecretHash: hashSecret(clientSecret),
      name: trimmed,
      userId,
      redirectUris: [],
      source: 'registered',
      clientName: trimmed,
    });

    return {
      client: toSummary(doc),
      clientId,
      clientSecret,
    };
  }

  async listRegisteredClients(userId: string): Promise<McpOAuthClientSummary[]> {
    const docs = await McpOAuthClientModel.find({ userId, source: 'registered' })
      .sort({ createdAt: -1 })
      .lean();
    return docs.map((doc) => toSummary(doc));
  }

  async revokeRegisteredClient(userId: string, id: string): Promise<McpOAuthClientSummary | null> {
    const doc = await McpOAuthClientModel.findOneAndUpdate(
      { _id: id, userId, source: 'registered', revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
      { new: true }
    ).lean();
    return doc ? toSummary(doc) : null;
  }

  async registerDynamicClient(body: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
  }): Promise<{ client_id: string; client_secret?: string; client_name: string; redirect_uris: string[] }> {
    const redirectUris = body.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      throw new HttpError(400, 'redirect_uris is required');
    }
    for (const uri of redirectUris) {
      if (!isHttpsUrl(uri) && !uri.startsWith('http://127.0.0.1') && !uri.startsWith('http://localhost')) {
        throw new HttpError(400, 'Invalid redirect URI');
      }
    }

    const clientId = `${CLIENT_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
    const clientSecret = `${CLIENT_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
    const clientName = body.client_name?.trim() || 'MCP Client';

    await McpOAuthClientModel.create({
      clientId,
      clientSecretHash: hashSecret(clientSecret),
      name: clientName,
      redirectUris,
      source: 'dcr',
      clientName,
    });

    return {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: clientName,
      redirect_uris: redirectUris,
    };
  }

  async resolveClient(clientId: string): Promise<ResolvedOAuthClient | null> {
    if (isUrlFormattedClientId(clientId)) {
      return this.resolveCimdClient(clientId);
    }

    const doc = await McpOAuthClientModel.findOne({ clientId, revokedAt: { $exists: false } }).lean();
    if (!doc) return null;

    return {
      clientId: doc.clientId,
      name: doc.clientName ?? doc.name,
      source: doc.source as McpOAuthClientSource,
      redirectUris: doc.redirectUris ?? [],
      clientSecretHash: doc.clientSecretHash ?? undefined,
      userId: doc.userId ?? undefined,
      revokedAt: doc.revokedAt,
    };
  }

  private async resolveCimdClient(clientIdUrl: string): Promise<ResolvedOAuthClient | null> {
    let doc = await McpOAuthClientModel.findOne({ clientId: clientIdUrl, source: 'cimd' }).lean();
    const metadata = await fetchClientMetadataDocument(clientIdUrl);

    if (!doc) {
      doc = await McpOAuthClientModel.create({
        clientId: clientIdUrl,
        name: metadata.client_name!,
        clientName: metadata.client_name!,
        redirectUris: metadata.redirect_uris ?? [],
        source: 'cimd',
      });
    } else if (!doc.revokedAt) {
      await McpOAuthClientModel.updateOne(
        { _id: doc._id },
        {
          $set: {
            name: metadata.client_name!,
            clientName: metadata.client_name!,
            redirectUris: metadata.redirect_uris ?? [],
          },
        }
      );
    }

    if (doc.revokedAt) return null;

    return {
      clientId: clientIdUrl,
      name: metadata.client_name!,
      source: 'cimd',
      redirectUris: metadata.redirect_uris ?? [],
    };
  }

  validateRedirectUri(client: ResolvedOAuthClient, redirectUri: string): boolean {
    if (client.redirectUris.length === 0) {
      return (
        isHttpsUrl(redirectUri) ||
        redirectUri.startsWith('http://127.0.0.1') ||
        redirectUri.startsWith('http://localhost')
      );
    }
    return client.redirectUris.includes(redirectUri);
  }

  verifyClientSecret(client: ResolvedOAuthClient, secret: string | undefined): boolean {
    if (!client.clientSecretHash) {
      return true;
    }
    if (!secret) return false;
    const hash = hashSecret(secret);
    try {
      const a = Buffer.from(hash);
      const b = Buffer.from(client.clientSecretHash);
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}

export const mcpOAuthClientService = new McpOAuthClientService();
