import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { Types } from 'mongoose';
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

/**
 * True only for a real loopback http URL. Parses the URL and checks the
 * hostname exactly — a prior version used string prefix matching
 * (value.startsWith('http://127.0.0.1')), which "http://127.0.0.1.evil.com"
 * also satisfies despite not being loopback at all.
 */
function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1')
    );
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

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateOrReservedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateOrReservedIPv4(mapped[1]);
  return false;
}

function isDisallowedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateOrReservedIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateOrReservedIPv6(ip);
  return true;
}

/**
 * Resolves the URL's host and rejects private/loopback/link-local/reserved
 * targets, blocking SSRF to internal services. This is a defense-in-depth
 * check, not a DNS-rebind-proof fetch (the actual fetch() may re-resolve),
 * but it closes the trivial "point client_id at an internal host" case.
 */
async function assertPublicHttpsUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'Invalid OAuth client metadata URL');
  }
  if (url.protocol !== 'https:') {
    throw new HttpError(400, 'OAuth client metadata URL must use https');
  }
  // url.hostname keeps brackets around IPv6 literals (e.g. "[::1]"); strip
  // them so net.isIP recognizes it and the IP-range check below applies.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new HttpError(400, 'OAuth client metadata URL host is not allowed');
  }
  if (net.isIP(hostname)) {
    if (isDisallowedIp(hostname)) {
      throw new HttpError(400, 'OAuth client metadata URL host is not allowed');
    }
    return;
  }
  let addresses: string[];
  try {
    addresses = (await dns.promises.lookup(hostname, { all: true })).map((a) => a.address);
  } catch {
    throw new HttpError(400, 'Could not resolve OAuth client metadata URL host');
  }
  if (addresses.length === 0 || addresses.some(isDisallowedIp)) {
    throw new HttpError(400, 'OAuth client metadata URL host is not allowed');
  }
}

const MAX_CIMD_REDIRECTS = 3;

async function fetchClientMetadataDocument(clientIdUrl: string): Promise<ClientMetadataDocument> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    let currentUrl = clientIdUrl;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_CIMD_REDIRECTS; hop += 1) {
      await assertPublicHttpsUrl(currentUrl);
      response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }
    if (!response || !response.ok) {
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
    // A caller-supplied id that isn't an ObjectId would make Mongoose throw a
    // CastError, surfacing as a 500 instead of the 404 the route already
    // handles for an id that simply doesn't exist.
    if (!Types.ObjectId.isValid(id)) return null;

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
      if (!isHttpsUrl(uri) && !isLoopbackHttpUrl(uri)) {
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
      // Only self-service "registered" clients (createRegisteredClient) can
      // reach here — DCR and CIMD clients always have explicit
      // redirectUris. Registered clients intentionally have no fixed
      // redirect_uri because they're for local/CLI tools that bind an
      // ephemeral port each run, so pin the fallback to loopback rather
      // than accepting any https:// target, which would let anyone who
      // gets a victim to click a crafted /oauth/authorize link redirect
      // that victim's own authorization code to an arbitrary https host.
      return isLoopbackHttpUrl(redirectUri);
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
