/**
 * The device's sync controls, under /api/local-sync (local mode only).
 *
 * A distinct prefix on purpose: /api/sync is the cloud hub's protocol (hello, pull,
 * push), which a device speaks as a client, never serves over HTTP. These routes sit
 * behind the device-token check like everything else in local mode; they need no
 * session, so the native app can call them directly (menu "Sync Now").
 *
 *   GET    /status                      engine, peers (transport, last synced, pending), cloud, pairing, log, conflicts
 *   GET    /revision?since=N&wait=ms    long poll: answers when remote changes were applied (or the owner changed)
 *   POST   /now                         sync with every connected peer and the cloud
 *   POST   /pair/open                   open a pairing window: QR link + SVG, typed address, Bluetooth link
 *   POST   /pair/join      {link}       join from a pasted/scanned link or a typed host:port
 *   POST   /pair/confirm   {accept}     confirm (or reject) the six-digit code both screens show
 *   GET    /pair                        the current pairing state
 *   DELETE /pair                        cancel
 *   GET    /peers                       paired devices
 *   DELETE /peers/:id                   unpair
 *   POST   /peers/:id/address {host, port}  manual address for a paired device
 *   POST   /bluetooth      {enabled}    Bluetooth sync on/off (persisted)
 *   POST   /cloud/sign-in  {hubUrl, token | email+password}
 *   POST   /cloud/sign-out
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { getLocalSync, type LocalSync } from './sync.js';

type Handler = (sync: LocalSync, req: Request, res: Response) => Promise<unknown> | unknown;

function route(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const sync = getLocalSync();
    if (!sync) {
      res.status(503).json({ error: 'Device sync is not running' });
      return;
    }
    try {
      const out = await fn(sync, req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (error) {
      if (res.headersSent) return next(error);
      res.status(400).json({ error: (error as Error).message });
    }
  };
}

export function createLocalSyncRouter(): Router {
  const r = Router();
  r.get('/status', route((s) => s.status()));
  r.get(
    '/revision',
    route(async (s, req) => {
      const since = Number(req.query.since);
      const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), 25_000);
      if (Number.isFinite(since) && wait > 0) await s.waitForRevision(since, wait);
      return { revision: s.revision, ownerRevision: s.ownerRevision, ownerId: s.owner.ownerId };
    })
  );
  r.post(
    '/now',
    route(async (s) => {
      await s.syncNow();
      return { ok: true, revision: s.revision };
    })
  );
  r.post('/pair/open', route((s) => s.openPairing()));
  r.post(
    '/pair/join',
    route((s, req) => {
      const link = (req.body as { link?: unknown })?.link;
      if (typeof link !== 'string' || !link.trim()) throw new Error('link is required');
      return s.joinPairing(link);
    })
  );
  r.post(
    '/pair/confirm',
    route((s, req) => s.confirmPairing((req.body as { accept?: unknown })?.accept !== false))
  );
  r.get('/pair', route((s) => ({ pairing: s.pairing })));
  r.delete(
    '/pair',
    route((s) => {
      s.cancelPairing();
      return { pairing: s.pairing };
    })
  );
  r.get(
    '/peers',
    route(async (s) => ({ peers: ((await s.status()) as { peers: unknown[] }).peers }))
  );
  r.delete(
    '/peers/:id',
    route(async (s, req, res) => {
      const removed = await s.unpair(String(req.params.id));
      if (!removed) res.status(404).json({ error: 'Not a paired device' });
      return { ok: true };
    })
  );
  r.post(
    '/peers/:id/address',
    route(async (s, req) => {
      const { host, port } = (req.body ?? {}) as { host?: unknown; port?: unknown };
      if (typeof host !== 'string' || !host || !Number.isInteger(port)) throw new Error('host and port are required');
      await s.addAddress(String(req.params.id), host, port as number);
      return { ok: true };
    })
  );
  r.post(
    '/bluetooth',
    route(async (s, req) => {
      const enabled = (req.body as { enabled?: unknown })?.enabled;
      if (typeof enabled !== 'boolean') throw new Error('enabled (boolean) is required');
      await s.setBluetooth(enabled);
      return { ok: true, enabled };
    })
  );
  r.post(
    '/cloud/sign-in',
    route((s, req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      return s.signIn({ hubUrl: str(b.hubUrl) ?? '', token: str(b.token), email: str(b.email), password: str(b.password) });
    })
  );
  r.post(
    '/cloud/sign-out',
    route(async (s) => {
      await s.signOut();
      return { ok: true };
    })
  );
  return r;
}
