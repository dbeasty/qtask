/**
 * Minimal self-signed X.509 certificate builder (ECDSA P-256 / SHA-256).
 *
 * node:crypto can generate keys and sign but cannot produce a certificate, and we
 * deliberately avoid shelling out to openssl or taking a dependency for one
 * 40-line DER structure. The certificate is only ever used for TLS transport
 * encryption between paired devices; trust comes from the pinned SHA-256
 * fingerprint recorded in the signed pairing record, never from a CA or a name.
 */

import { createHash, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const oid = (...arcs: number[]): Buffer => {
  const body: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const a of arcs.slice(2)) {
    const chunk: number[] = [a & 0x7f];
    let v = a >> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    body.push(...chunk);
  }
  return tlv(0x06, Buffer.from(body));
};
const utcTime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
};

const ECDSA_SHA256 = oid(1, 2, 840, 10045, 4, 3, 2);

export interface SelfSignedCert {
  der: Buffer;
  pem: string;
  /** Lowercase hex SHA-256 of the DER: the value that gets pinned. */
  fingerprint: string;
}

export function fingerprintDer(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

export function createSelfSignedCert(
  privateKey: KeyObject,
  commonName: string,
  now = new Date(),
  validYears = 10,
): SelfSignedCert {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const name = seq(set(seq(oid(2, 5, 4, 3), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f; // positive
  if (serial[0] === 0) serial[0] = 1;
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + validYears);
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, serial),
    seq(ECDSA_SHA256),
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    Buffer.from(spki),
  );
  const sig = sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  const der = seq(tbs, seq(ECDSA_SHA256), tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
  return { der, pem, fingerprint: fingerprintDer(der) };
}
