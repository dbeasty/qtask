/**
 * The pairing proofs shared by every transport that can carry the pairing dialogue
 * (LAN over TLS, Bluetooth over its pre-auth sealed session).
 *
 * `exporter` is 32 bytes that bind the dialogue to the one secure channel it runs in:
 * the TLS keying-material exporter on LAN, a value derived from the ephemeral
 * Diffie-Hellman secret on Bluetooth. A man in the middle necessarily holds two
 * different channels, hence two different transcripts and two different codes, and
 * cannot compute a QR-secret MAC at all.
 */

import { createHash, createHmac } from 'node:crypto';
import { canonicalJson, type DeviceInfo } from './identity.js';

function sha256(...parts: Array<string | Buffer>): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

export function pairTranscript(
  inviter: DeviceInfo,
  joiner: DeviceInfo,
  ni: string,
  nj: string,
  ts: number,
  exporter: Buffer,
): Buffer {
  return sha256(canonicalJson({ i: inviter, j: joiner, ni, nj, ts }), exporter);
}

export function pairMac(secret: Buffer, role: 'I' | 'J', transcript: Buffer): string {
  return createHmac('sha256', secret).update(role).update(transcript).digest('hex');
}

/** Six digits both screens show; the users confirm they match. */
export function pairSas(transcript: Buffer): string {
  return String(sha256('qtask-sas', transcript).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}
