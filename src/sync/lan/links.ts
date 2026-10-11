/**
 * `qtask://` deep links used for the manual / QR fallbacks.
 *
 *   qtask://sync?h=192.168.1.20:41234&id=<nodeId>
 *       Manual address of an already-paired peer (client-isolated Wi-Fi where mDNS
 *       cannot cross, a phone hotspot, a typed-in address).
 *
 *   qtask://pair?h=192.168.1.20:41234&id=<nodeId>&fp=<certFp>&s=<secret>
 *       Pairing invitation shown as a QR code. `fp` pins the inviter's certificate
 *       before any byte is exchanged; `s` is a one-time 128-bit secret that proves
 *       the joiner saw the QR code.
 */

export interface SyncLink {
  host: string;
  port: number;
  id?: string;
}
export interface PairLink {
  host: string;
  port: number;
  id?: string;
  fp?: string;
  secret?: string;
}

const HOST_RE = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)$/;

function parseHostPort(h: string | null): { host: string; port: number } | null {
  if (!h || h.length > 300) return null;
  const i = h.lastIndexOf(':');
  if (i <= 0) return null;
  const host = h.slice(0, i);
  const portStr = h.slice(i + 1);
  if (!/^\d{1,5}$/.test(portStr) || !HOST_RE.test(host)) return null;
  const port = Number(portStr);
  if (port < 1 || port > 65535) return null;
  return { host: host.startsWith('[') ? host.slice(1, -1) : host, port };
}

function hostPart(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function parse(url: string, kind: string): URLSearchParams | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'qtask:' || u.hostname !== kind) return null;
  return u.searchParams;
}

export function formatSyncLink(l: SyncLink): string {
  const q = new URLSearchParams({ h: hostPart(l.host, l.port) });
  if (l.id) q.set('id', l.id);
  return `qtask://sync?${q.toString().replace(/%3A/gi, ':')}`;
}

export function parseSyncLink(url: string): SyncLink | null {
  const q = parse(url, 'sync');
  if (!q) return null;
  const hp = parseHostPort(q.get('h'));
  const id = q.get('id') ?? undefined;
  if (!hp || (id !== undefined && !/^[0-9a-f]{32}$/.test(id))) return null;
  return { ...hp, id };
}

export function formatPairLink(l: PairLink): string {
  const q = new URLSearchParams({ h: hostPart(l.host, l.port) });
  if (l.id) q.set('id', l.id);
  if (l.fp) q.set('fp', l.fp);
  if (l.secret) q.set('s', l.secret);
  return `qtask://pair?${q.toString().replace(/%3A/gi, ':')}`;
}

export function parsePairLink(url: string): PairLink | null {
  const q = parse(url, 'pair');
  if (!q) return null;
  const hp = parseHostPort(q.get('h'));
  const id = q.get('id') ?? undefined;
  const fp = q.get('fp') ?? undefined;
  const secret = q.get('s') ?? undefined;
  if (!hp) return null;
  if (id !== undefined && !/^[0-9a-f]{32}$/.test(id)) return null;
  if (fp !== undefined && !/^[0-9a-f]{64}$/.test(fp)) return null;
  if (secret !== undefined && !/^[A-Za-z0-9_-]{16,64}$/.test(secret)) return null;
  return { ...hp, id, fp, secret };
}
