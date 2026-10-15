/**
 * The device's sync controls (local mode only): /api/local-sync on the backend inside the
 * Mac app. The app's bridge adds the device token; no session is needed.
 */

export type LinkKind = 'wifi' | 'bluetooth';

export interface PeerInfo {
  nodeId: string;
  name: string;
  pairedAt: string;
  connected: boolean;
  transport: LinkKind | null;
  links: LinkKind[];
  lastSyncedAt: string | null;
  lastTransport: LinkKind | null;
  pendingChanges: number;
  lastError: string | null;
}

export interface PairingState {
  id: number;
  role: 'inviter' | 'joiner';
  phase: 'waiting' | 'connecting' | 'confirm' | 'paired' | 'failed' | 'cancelled';
  link?: string;
  codeLink?: string;
  address?: string;
  bleLink?: string;
  qrSvg?: string;
  expiresAt?: string;
  sas?: string;
  peerName?: string;
  peerId?: string;
  error?: string;
}

export interface SyncEvent {
  at: string;
  kind: string;
  peerName?: string;
  transport?: LinkKind | 'cloud';
  message: string;
}

export interface ConflictInfo {
  id: string;
  at: string;
  collection?: string;
  documentId?: string;
  title?: string;
  field?: string;
  kept?: unknown;
  discarded?: unknown;
}

export interface SyncStatus {
  enabled: boolean;
  device: { nodeId: string; name: string; ownerId: string; signedIn: boolean; account: { hubUrl: string; email?: string } | null };
  revision: number;
  ownerRevision: number;
  pendingChanges: number;
  lastSyncedAt: string | null;
  documents: number;
  wifi: { running: boolean; port?: number };
  bluetooth: { available: boolean; enabled: boolean; radio: string | null };
  peers: PeerInfo[];
  cloud: { hubUrl: string; email: string | null; state: string; lastSyncedAt: string | null; pendingChanges: number | null; lastError: string | null } | null;
  pairing: PairingState | null;
  log: SyncEvent[];
  conflicts: ConflictInfo[];
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/local-sync${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) throw new Error((parsed as { error?: string } | null)?.error ?? `Request failed (${response.status})`);
  return parsed as T;
}

export const localSync = {
  status: () => call<SyncStatus>('GET', '/status'),
  revision: (since?: number, waitMs = 0, signal?: AbortSignal) =>
    call<{ revision: number; ownerRevision: number; ownerId: string }>(
      'GET',
      since === undefined ? '/revision' : `/revision?since=${since}&wait=${waitMs}`,
      undefined,
      signal
    ),
  syncNow: () => call<{ ok: boolean }>('POST', '/now'),
  openPairing: () => call<PairingState>('POST', '/pair/open'),
  joinPairing: (link: string) => call<PairingState>('POST', '/pair/join', { link }),
  confirmPairing: (accept: boolean) => call<PairingState>('POST', '/pair/confirm', { accept }),
  pairing: () => call<{ pairing: PairingState | null }>('GET', '/pair'),
  cancelPairing: () => call<{ pairing: PairingState | null }>('DELETE', '/pair'),
  unpair: (nodeId: string) => call<{ ok: boolean }>('DELETE', `/peers/${encodeURIComponent(nodeId)}`),
  setBluetooth: (enabled: boolean) => call<{ ok: boolean }>('POST', '/bluetooth', { enabled }),
  signIn: (input: { hubUrl: string; email: string; password: string }) =>
    call<{ userId: string }>('POST', '/cloud/sign-in', input),
  signOut: () => call<{ ok: boolean }>('POST', '/cloud/sign-out'),
};
