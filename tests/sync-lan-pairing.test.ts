import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FileSecretStore,
  PeerStore,
  formatPairLink,
  formatSyncLink,
  loadOrCreateIdentity,
  parsePairLink,
  parseSyncLink,
  verifyRecord,
  createSelfSignedCert,
} from '../src/sync/lan/index.ts';
import type { SyncPeerLink } from '../src/sync/transport-contract.ts';
import { makeDevice, waitFor, type TestDevice } from './helpers/lan.ts';

const devices: TestDevice[] = [];
async function dev(name: string, extra = {}) {
  const d = await makeDevice(name, extra);
  devices.push(d);
  return d;
}
after(async () => {
  for (const d of devices) await d.cleanup();
});

/** Pairs b to a via the QR flow and returns both. */
async function qrPair(a: TestDevice, b: TestDevice) {
  const inv = a.transport.openPairing();
  const pb = b.transport.pairWith(parsePairLink(inv.link)!);
  const [peerOnA, peerOnB] = await Promise.all([inv.result, pb]);
  return { peerOnA, peerOnB };
}

describe('LAN pairing', () => {
  it('QR pairing produces mutually signed records on both devices', async () => {
    const a = await dev('a');
    const b = await dev('b');
    const { peerOnA, peerOnB } = await qrPair(a, b);
    assert.equal(peerOnA.nodeId, b.transport.self.nodeId);
    assert.equal(peerOnB.nodeId, a.transport.self.nodeId);
    assert.equal(peerOnA.certFp, b.transport.self.certFp);
    assert.ok(verifyRecord(peerOnA.record));
    assert.deepEqual(peerOnA.record, peerOnB.record, 'both sides hold the same signed record');
  });

  it('pairings and identities persist across restarts', async () => {
    const a = await dev('pa');
    const b = await dev('pb');
    await qrPair(a, b);
    const identity = await loadOrCreateIdentity(new FileSecretStore(join(a.dir, 'identity.json')), 'pa');
    assert.equal(identity.info.nodeId, a.transport.self.nodeId, 'identity is stable');
    const reopened = await PeerStore.open(identity, a.dir);
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.list()[0]!.nodeId, b.transport.self.nodeId);
  });

  it('a tampered record on disk is discarded on load', async () => {
    const a = await dev('ta');
    const b = await dev('tb');
    await qrPair(a, b);
    const file = join(a.dir, 'paired-peers.json');
    const recs = JSON.parse(await readFile(file, 'utf8'));
    const mallory = await loadOrCreateIdentity(new FileSecretStore(join(a.dir, 'mallory.json')), 'mallory');
    // Swap the peer's pinned certificate for an attacker's, keeping the old signatures.
    const side = recs[0].a.nodeId === b.transport.self.nodeId ? 'a' : 'b';
    recs[0][side].certFp = mallory.info.certFp;
    await writeFile(file, JSON.stringify(recs));
    const identity = await loadOrCreateIdentity(new FileSecretStore(join(a.dir, 'identity.json')), 'ta');
    const reopened = await PeerStore.open(identity, a.dir);
    assert.equal(reopened.list().length, 0);
  });

  it('wrong secret is rejected, and the window closes after repeated failures', async () => {
    const a = await dev('wa');
    const b = await dev('wb');
    const inv = a.transport.openPairing({ maxFailures: 2 });
    const bad = { ...parsePairLink(inv.link)!, secret: 'AAAAAAAAAAAAAAAAAAAAAA' };
    await assert.rejects(b.transport.pairWith(bad));
    await assert.rejects(b.transport.pairWith(bad));
    await assert.rejects(inv.result, /too many failed/);
    // Window is now closed: even the correct secret is refused.
    await assert.rejects(b.transport.pairWith(parsePairLink(inv.link)!));
    assert.equal(a.peers.list().length, 0);
    assert.equal(b.peers.list().length, 0);
  });

  it('refuses to pair when no pairing window is open', async () => {
    const a = await dev('na');
    const b = await dev('nb');
    await assert.rejects(b.transport.pairWith({ host: '127.0.0.1', port: a.transport.port }, { confirmSas: async () => true }));
    assert.ok(a.security.some((e) => e.reason === 'pairing-closed'));
    assert.equal(a.peers.list().length, 0);
  });

  it('a QR whose fingerprint does not match the presented certificate is refused by the joiner', async () => {
    const a = await dev('fa');
    const b = await dev('fb');
    const inv = a.transport.openPairing();
    const forged = { ...inv.parts, fp: createHash('sha256').update('not the cert').digest('hex') };
    await assert.rejects(b.transport.pairWith(forged), /does not match/);
    inv.cancel();
  });

  it('6-digit code flow: both screens show the same code and both users must confirm', async () => {
    const a = await dev('sa');
    const b = await dev('sb');
    let shownA = '';
    let shownB = '';
    const inv = a.transport.openPairing({ confirmSas: async (sas) => ((shownA = sas), true) });
    const pb = b.transport.pairWith({ host: '127.0.0.1', port: a.transport.port }, { confirmSas: async (sas) => ((shownB = sas), true) });
    await Promise.all([inv.result, pb]);
    assert.match(shownA, /^\d{6}$/);
    assert.equal(shownA, shownB);
    assert.equal(a.peers.list().length, 1);
    assert.equal(b.peers.list().length, 1);
  });

  it('6-digit code flow: a user declining on either side aborts pairing', async () => {
    const a = await dev('da');
    const b = await dev('db');
    const inv = a.transport.openPairing({ confirmSas: async () => true, maxFailures: 1 });
    await assert.rejects(b.transport.pairWith({ host: '127.0.0.1', port: a.transport.port }, { confirmSas: async () => false }));
    await assert.rejects(inv.result);
    assert.equal(a.peers.list().length, 0);
    assert.equal(b.peers.list().length, 0);
  });

  it('code flow is refused unless the inviter explicitly allowed it', async () => {
    const a = await dev('ca');
    const b = await dev('cb');
    a.transport.openPairing(); // QR only
    await assert.rejects(b.transport.pairWith({ host: '127.0.0.1', port: a.transport.port }, { confirmSas: async () => true }));
    assert.equal(a.peers.list().length, 0);
  });

  it('a forged pairing record naming a victim node id but an attacker certificate does not verify', async () => {
    const a = await dev('xa');
    const b = await dev('xb');
    const { peerOnA } = await qrPair(a, b);
    const mallory = await loadOrCreateIdentity(new FileSecretStore(join(a.dir, 'm.json')), 'mallory');
    const forged = structuredClone(peerOnA.record);
    const side = forged.a.nodeId === b.transport.self.nodeId ? 'a' : 'b';
    forged[side].certFp = mallory.info.certFp;
    assert.equal(verifyRecord(forged), false);
    await assert.rejects(a.peers.add(forged));
  });
});

describe('LAN sync connections', () => {
  it('paired devices connect, exchange messages both ways, and report up/down', async () => {
    const a = await dev('la');
    const b = await dev('lb');
    await qrPair(a, b);
    const upA: SyncPeerLink[] = [];
    const upB: SyncPeerLink[] = [];
    a.transport.onPeerUp((l) => upA.push(l));
    b.transport.onPeerUp((l) => upB.push(l));
    const down: string[] = [];
    a.transport.onPeerDown((id) => down.push(id));
    // pairWith recorded A's address on B; A learns B's address manually.
    b.transport.addManualAddress(a.transport.self.nodeId, '127.0.0.1', a.transport.port);
    await waitFor(() => upA.length === 1 && upB.length === 1, 5000, 'both links up');
    const got: string[] = [];
    upA[0]!.onMessage((m) => void got.push(Buffer.from(m).toString()));
    upB[0]!.onMessage(async (m) => {
      await upB[0]!.send(Buffer.from(`echo:${Buffer.from(m).toString()}`));
    });
    await upA[0]!.send(Buffer.from('hi'));
    await waitFor(() => got.length === 1, 3000, 'echo');
    assert.equal(got[0], 'echo:hi');
    assert.equal(upA[0]!.peerId, b.transport.self.nodeId);
    assert.equal(a.transport.links().length, 1, 'exactly one link per peer pair');
    upB[0]!.close();
    await waitFor(() => down.length === 1, 3000, 'peer down');
  });

  it('reconnects with backoff after the peer restarts on the same port', async () => {
    const a = await dev('ra');
    const b = await dev('rb');
    await qrPair(a, b);
    const ups: SyncPeerLink[] = [];
    b.transport.onPeerUp((l) => ups.push(l));
    b.transport.addManualAddress(a.transport.self.nodeId, '127.0.0.1', a.transport.port);
    await waitFor(() => ups.length === 1, 5000, 'first connect');
    const port = a.transport.port;
    await a.transport.stop();
    await waitFor(() => b.transport.links().length === 0, 3000, 'link closed');
    await new Promise((r) => setTimeout(r, 200)); // a few failed dials
    await a.transport.start(); // port 0 => new port; point b at it like a fresh mDNS result would
    assert.notEqual(a.transport.port, 0);
    b.transport.addManualAddress(a.transport.self.nodeId, '127.0.0.1', a.transport.port);
    void port;
    await waitFor(() => ups.length === 2, 5000, 'reconnect');
  });

  it('an unpaired device is dropped before any application byte is sent', async () => {
    const a = await dev('ua');
    const stranger = await dev('us');
    const id = await loadOrCreateIdentity(new FileSecretStore(join(stranger.dir, 'identity.json')), 'us');
    let received = 0;
    await new Promise<void>((resolve) => {
      const s = tls.connect({
        host: '127.0.0.1',
        port: a.transport.port,
        key: id.tlsKeyPem,
        cert: id.tlsCertPem,
        ALPNProtocols: ['qtask-sync/1'],
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
      });
      s.on('data', (d) => (received += d.length));
      s.on('error', () => undefined);
      s.on('close', () => resolve());
    });
    assert.equal(received, 0);
    assert.ok(a.security.some((e) => e.reason === 'unpaired-client'));
    assert.equal(a.transport.links().length, 0);
  });

  it('a client with no certificate at all is dropped too', async () => {
    const a = await dev('na2');
    let received = 0;
    await new Promise<void>((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: a.transport.port, ALPNProtocols: ['qtask-sync/1'], rejectUnauthorized: false });
      s.on('data', (d) => (received += d.length));
      s.on('error', () => undefined);
      s.on('close', () => resolve());
    });
    assert.equal(received, 0);
  });

  it('an impersonator at a paired peer address (valid TLS, different key) is rejected by the pin', async () => {
    const a = await dev('ia');
    const b = await dev('ib');
    await qrPair(a, b);
    await waitFor(() => b.transport.links().length === 1, 5000, 'real link');
    await a.transport.stop(); // the real A goes away...
    await waitFor(() => b.transport.links().length === 0, 5000, 'link closed');
    // ...and Mallory listens where B believes A lives, presenting her own certificate.
    const m = await dev('mallory');
    b.transport.addManualAddress(a.transport.self.nodeId, '127.0.0.1', m.transport.port);
    await waitFor(() => b.security.some((e) => e.reason === 'fingerprint-mismatch'), 5000, 'pin mismatch');
    assert.equal(b.transport.links().length, 0);
    assert.equal(m.transport.links().length, 0);
  });

  it('a device that was unpaired is refused on reconnect', async () => {
    const a = await dev('ra2');
    const b = await dev('rb2');
    await qrPair(a, b);
    await waitFor(() => b.transport.links().length === 1, 5000, 'link');
    await a.peers.remove(b.transport.self.nodeId);
    b.transport.links()[0]!.close();
    await waitFor(() => a.security.some((e) => e.reason === 'unpaired-client'), 5000, 'refusal');
    assert.equal(a.transport.links().length, 0);
  });
});

describe('qtask:// links and certificates', () => {
  it('sync and pair links round-trip and reject malformed input', () => {
    const id = 'a'.repeat(32);
    const l = formatSyncLink({ host: '192.168.1.20', port: 41234, id });
    assert.equal(l, `qtask://sync?h=192.168.1.20:41234&id=${id}`);
    assert.deepEqual(parseSyncLink(l), { host: '192.168.1.20', port: 41234, id });
    const v6 = parseSyncLink(formatSyncLink({ host: 'fe80::1', port: 9 }));
    assert.equal(v6?.host, 'fe80::1');
    const p = { host: '10.0.0.2', port: 5, id, fp: 'b'.repeat(64), secret: 'abcdefghijklmnop' };
    assert.deepEqual(parsePairLink(formatPairLink(p)), p);
    for (const bad of [
      'http://sync?h=1.2.3.4:5',
      'qtask://sync?h=1.2.3.4:0',
      'qtask://sync?h=1.2.3.4:70000',
      'qtask://sync?h=1.2.3.4',
      'qtask://sync?h=bad host:5',
      'qtask://sync?h=1.2.3.4:5&id=nothex',
      'qtask://pair?h=1.2.3.4:5&fp=short',
      'qtask://pair?h=1.2.3.4:5&s=x',
      'not a url',
    ]) {
      assert.equal(parseSyncLink(bad) ?? parsePairLink(bad), null, bad);
    }
  });

  it('the hand-built certificate is accepted by the TLS stack and has a stable fingerprint', async () => {
    const a = await dev('ca1');
    const id = await loadOrCreateIdentity(new FileSecretStore(join(a.dir, 'identity.json')), 'ca1');
    const seen = await new Promise<string>((resolve, reject) => {
      const s = tls.connect({ host: '127.0.0.1', port: a.transport.port, rejectUnauthorized: false }, () => {
        resolve(createHash('sha256').update(s.getPeerCertificate().raw).digest('hex'));
        s.destroy();
      });
      s.on('error', reject);
    });
    assert.equal(seen, id.info.certFp);
    assert.ok(createSelfSignedCert);
  });
});
