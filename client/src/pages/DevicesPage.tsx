import { useCallback, useEffect, useState } from 'react';
import { localSync, type ConflictInfo, type PairingState, type PeerInfo, type SyncStatus } from '../api/localSync';

/**
 * Devices & Sync (Mac app only): this device, paired devices and how they are reached,
 * pairing (QR code, typed address with a six-digit code, or a pasted link), Bluetooth,
 * the cloud account, pending changes, conflicts and recent sync activity.
 */

interface DevicesPageProps {
  /** Bumped by File > Pair Device… to open a pairing window. */
  pairRequest?: number;
  onBack?: () => void;
}

function relative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'never';
  if (ms < 10_000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return new Date(iso).toLocaleString();
}

const transportLabel = (t: string | null | undefined) => (t === 'bluetooth' ? 'Bluetooth' : t === 'wifi' ? 'Wi-Fi' : t === 'cloud' ? 'Cloud' : '');

function show(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return value || '(empty)';
  if (typeof value === 'object' && value && '$date' in (value as Record<string, unknown>)) {
    return new Date(String((value as { $date: string }).$date)).toLocaleString();
  }
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function PeerRow({ peer, onUnpair }: { peer: PeerInfo; onUnpair: (peer: PeerInfo) => void }) {
  const via = peer.connected ? transportLabel(peer.transport) : null;
  return (
    <li className="devices-peer" data-node-id={peer.nodeId}>
      <div className="devices-peer-main">
        <strong className="devices-peer-name">{peer.name}</strong>
        <span className={`devices-badge ${peer.connected ? 'devices-badge--on' : ''}`}>
          {via ? `Connected · ${via}` : 'Not nearby'}
        </span>
      </div>
      <div className="muted devices-peer-meta">
        Last synced {relative(peer.lastSyncedAt)}
        {peer.lastTransport ? ` over ${transportLabel(peer.lastTransport)}` : ''}
        {peer.pendingChanges > 0 ? ` · ${peer.pendingChanges} change${peer.pendingChanges === 1 ? '' : 's'} waiting` : ''}
        {peer.lastError ? ` · ${peer.lastError}` : ''}
      </div>
      <button type="button" className="secondary-button devices-unpair" onClick={() => onUnpair(peer)}>
        Unpair
      </button>
    </li>
  );
}

function PairingPanel({
  pairing,
  onConfirm,
  onCancel,
}: {
  pairing: PairingState;
  onConfirm: (accept: boolean) => void;
  onCancel: () => void;
}) {
  if (pairing.phase === 'confirm' && pairing.sas) {
    return (
      <div className="devices-pairing devices-sas" role="alertdialog" aria-label="Confirm pairing code">
        <p>
          Pairing with <strong>{pairing.peerName ?? 'another device'}</strong>. Check that both screens show the same
          code:
        </p>
        <p className="devices-sas-code" data-testid="pairing-sas">
          {pairing.sas.slice(0, 3)} {pairing.sas.slice(3)}
        </p>
        <div className="devices-actions">
          <button type="button" className="primary-button" onClick={() => onConfirm(true)}>
            The codes match
          </button>
          <button type="button" className="secondary-button" onClick={() => onConfirm(false)}>
            They differ
          </button>
        </div>
      </div>
    );
  }
  if (pairing.phase === 'paired') {
    return (
      <div className="devices-pairing" role="status">
        Paired with <strong>{pairing.peerName}</strong>. Your devices now sync whenever they can reach each other.
      </div>
    );
  }
  if (pairing.phase === 'failed' || pairing.phase === 'cancelled') {
    return (
      <div className="devices-pairing" role="status">
        {pairing.phase === 'cancelled' ? 'Pairing cancelled.' : `Pairing did not work: ${pairing.error ?? 'unknown error'}`}
      </div>
    );
  }
  if (pairing.role === 'joiner') {
    return (
      <div className="devices-pairing" role="status">
        Connecting…{' '}
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="devices-pairing devices-invite">
      {pairing.qrSvg ? (
        // The SVG comes from this device's own backend (src/local/qr.ts): paths only, no script.
        <div className="devices-qr" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
      ) : null}
      <div className="devices-invite-text">
        <p>On the other device, open Devices &amp; Sync and choose <em>Join</em>, then paste this link:</p>
        <input className="devices-link" readOnly value={pairing.link ?? pairing.bleLink ?? ''} onFocus={(e) => e.currentTarget.select()} aria-label="Pairing link" />
        {pairing.address ? (
          <p className="muted">
            Or type the address <code data-testid="pairing-address">{pairing.address}</code> there; both screens will then
            show a six-digit code to compare.
          </p>
        ) : null}
        {pairing.bleLink && pairing.link ? <p className="muted">With no network, use the Bluetooth link: <code>{pairing.bleLink}</code></p> : null}
        <p className="muted">
          Waiting for the other device{pairing.expiresAt ? ` until ${new Date(pairing.expiresAt).toLocaleTimeString()}` : ''}.{' '}
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
        </p>
      </div>
    </div>
  );
}

function ConflictRow({ c }: { c: ConflictInfo }) {
  return (
    <li className="devices-conflict">
      <div>
        <strong>{c.title ?? c.documentId}</strong> <span className="muted">· {c.field} · {relative(c.at)}</span>
      </div>
      <div className="muted">
        Kept “{show(c.kept)}”, replaced “{show(c.discarded)}”
      </div>
    </li>
  );
}

let lastHandledPairRequest = 0;

export function DevicesPage({ pairRequest, onBack }: DevicesPageProps) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [joinLink, setJoinLink] = useState('');
  const [cloudForm, setCloudForm] = useState({ hubUrl: 'https://', email: '', password: '' });

  const refresh = useCallback(async () => {
    try {
      setStatus(await localSync.status());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const pairingActive = status?.pairing && ['waiting', 'connecting', 'confirm'].includes(status.pairing.phase);
    const timer = window.setInterval(() => void refresh(), pairingActive ? 1000 : 3000);
    return () => window.clearInterval(timer);
  }, [refresh, status?.pairing?.phase]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      try {
        await fn();
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh]
  );

  const openPairing = useCallback(() => run('pair', () => localSync.openPairing()), [run]);

  useEffect(() => {
    // Module-level, so the request that opened this page is honoured on mount but a later
    // visit to the page does not reopen a pairing window for an old request.
    if (pairRequest && pairRequest !== lastHandledPairRequest) {
      lastHandledPairRequest = pairRequest;
      void openPairing();
    }
  }, [pairRequest, openPairing]);

  const unpair = (peer: PeerInfo) => {
    if (!window.confirm(`Unpair ${peer.name}? The two devices stop syncing; data already on each stays.`)) return;
    void run('unpair', () => localSync.unpair(peer.nodeId));
  };

  const pairing = status?.pairing ?? null;
  const pairingVisible = pairing && !(pairing.phase === 'cancelled');

  return (
    <div className="about-page devices-page">
      <div className="about-page-inner">
        <div className="page-header">
          <h2>Devices &amp; Sync</h2>
          <div className="page-header-actions">
            <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void run('sync', () => localSync.syncNow())}>
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            {onBack ? (
              <button type="button" className="secondary-button" onClick={onBack}>
                Back
              </button>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="warning-banner" role="alert">
            {error}
          </div>
        ) : null}

        {!status ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <section className="about-section">
              <h3>This Mac</h3>
              <p>
                <strong data-testid="device-name">{status.device.name}</strong>
                <span className="muted">
                  {' '}
                  · {status.pendingChanges === 0 ? 'everything synced' : `${status.pendingChanges} change${status.pendingChanges === 1 ? '' : 's'} waiting`}
                  {' '}· last synced {relative(status.lastSyncedAt)}
                </span>
              </p>
              <p className="muted">
                Wi-Fi sync {status.wifi.running ? 'is on' : 'is off'}. Only devices you pair can connect; others on the
                network see nothing.
              </p>
              <label className="devices-toggle">
                <input
                  type="checkbox"
                  checked={status.bluetooth.enabled}
                  disabled={!status.bluetooth.available || busy !== null}
                  onChange={(e) => {
                    const enabled = e.currentTarget.checked;
                    void run('bluetooth', () => localSync.setBluetooth(enabled));
                  }}
                />{' '}
                Sync over Bluetooth when there is no network
                {!status.bluetooth.available ? <span className="muted"> (not available in this launch)</span> : null}
                {status.bluetooth.enabled && status.bluetooth.radio && status.bluetooth.radio !== 'on' ? (
                  <span className="muted"> · Bluetooth is {status.bluetooth.radio}</span>
                ) : null}
              </label>
            </section>

            <section className="about-section">
              <h3>Paired devices</h3>
              {status.peers.length === 0 ? (
                <p className="muted">No devices yet. Pair another Mac to keep your tasks in sync without the cloud.</p>
              ) : (
                <ul className="devices-peers">
                  {status.peers.map((peer) => (
                    <PeerRow key={peer.nodeId} peer={peer} onUnpair={unpair} />
                  ))}
                </ul>
              )}
            </section>

            <section className="about-section">
              <h3>Pair a device</h3>
              <div className="devices-actions">
                <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void openPairing()}>
                  Show pairing code
                </button>
              </div>
              <form
                className="devices-join"
                onSubmit={(e) => {
                  e.preventDefault();
                  const link = joinLink.trim();
                  if (link) void run('join', () => localSync.joinPairing(link)).then(() => setJoinLink(''));
                }}
              >
                <input
                  type="text"
                  value={joinLink}
                  placeholder="Paste a qtask://pair link, or type an address like 192.168.1.20:52344"
                  aria-label="Pairing link or address"
                  onChange={(e) => setJoinLink(e.currentTarget.value)}
                />
                <button type="submit" className="secondary-button" disabled={busy !== null || !joinLink.trim()}>
                  {busy === 'join' ? 'Joining…' : 'Join'}
                </button>
              </form>
              {pairingVisible ? (
                <PairingPanel
                  pairing={pairing}
                  onConfirm={(accept) => void run('confirm', () => localSync.confirmPairing(accept))}
                  onCancel={() => void run('cancel', () => localSync.cancelPairing())}
                />
              ) : null}
            </section>

            <section className="about-section">
              <h3>Cloud</h3>
              {status.cloud ? (
                <>
                  <p>
                    Signed in to <strong>{status.cloud.hubUrl}</strong>
                    {status.cloud.email ? ` as ${status.cloud.email}` : ''}
                    <span className="muted">
                      {' '}
                      · {status.cloud.state} · last synced {relative(status.cloud.lastSyncedAt)}
                      {status.cloud.lastError ? ` · ${status.cloud.lastError}` : ''}
                    </span>
                  </p>
                  <button type="button" className="secondary-button" onClick={() => void run('signout', () => localSync.signOut())}>
                    Sign out
                  </button>
                </>
              ) : (
                <form
                  className="devices-cloud"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run('signin', async () => {
                      await localSync.signIn(cloudForm);
                      setCloudForm((f) => ({ ...f, password: '' }));
                    });
                  }}
                >
                  <p className="muted">
                    Optional. Signing in moves the tasks on this Mac into your account and keeps them in sync with the web.
                  </p>
                  <input type="url" required placeholder="https://your-qtask-server" aria-label="Server address" value={cloudForm.hubUrl} onChange={(e) => setCloudForm({ ...cloudForm, hubUrl: e.currentTarget.value })} />
                  <input type="email" required placeholder="E-mail" aria-label="E-mail" value={cloudForm.email} onChange={(e) => setCloudForm({ ...cloudForm, email: e.currentTarget.value })} />
                  <input type="password" required placeholder="Password" aria-label="Password" value={cloudForm.password} onChange={(e) => setCloudForm({ ...cloudForm, password: e.currentTarget.value })} />
                  <button type="submit" className="secondary-button" disabled={busy !== null}>
                    {busy === 'signin' ? 'Signing in…' : 'Sign in'}
                  </button>
                </form>
              )}
            </section>

            <section className="about-section">
              <h3>Conflicts</h3>
              {status.conflicts.length === 0 ? (
                <p className="muted">None. When the same field is changed on two devices before they sync, the later change is kept and the other is listed here.</p>
              ) : (
                <ul className="devices-conflicts">
                  {status.conflicts.map((c) => (
                    <ConflictRow key={c.id} c={c} />
                  ))}
                </ul>
              )}
            </section>

            <section className="about-section">
              <h3>Recent activity</h3>
              {status.log.length === 0 ? (
                <p className="muted">Nothing yet.</p>
              ) : (
                <ul className="devices-log">
                  {status.log.slice(0, 15).map((e, i) => (
                    <li key={`${e.at}-${i}`}>
                      <span className="muted">{new Date(e.at).toLocaleTimeString()}</span> {e.message}
                      {e.transport ? <span className="muted"> · {transportLabel(e.transport)}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
