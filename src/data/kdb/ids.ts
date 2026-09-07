/**
 * Document identity for the KDB backend.
 *
 * qtask's `_id` is a 24-hex MongoDB ObjectId, and it leaks everywhere by design:
 * it is in URLs, in API responses, and `isValidObjectId` gates several routes. KDB
 * addresses documents by UUID. Rather than change the application's id shape — which
 * would make the two backends observably different at every boundary — the store
 * keeps minting ObjectId-shaped ids and derives the UUID KDB needs from them.
 *
 * The derivation is a left-pad, not a hash, so it is reversible and debuggable: a
 * document seen as `00000000-6890-…` in KDB is `6890…` in the application.
 */

import { createHash, randomBytes } from 'node:crypto';

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

let counter = randomBytes(3).readUIntBE(0, 3);
const processRandom = randomBytes(5);

/**
 * A new ObjectId-shaped id: 4-byte seconds, 5-byte per-process random, 3-byte
 * counter — the same layout MongoDB uses, so ids sort by creation time and collide
 * no more often than the driver's own.
 */
export function generateObjectId(): string {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
  processRandom.copy(buffer, 4);
  counter = (counter + 1) % 0xffffff;
  buffer.writeUIntBE(counter, 9, 3);
  return buffer.toString('hex');
}

export function isObjectIdLike(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

/**
 * The KDB document id for an application id. Left-pads the 24 hex characters to 32
 * and formats them as a UUID.
 *
 * A value that is not ObjectId-shaped still has to map to *something* stable — ids
 * reach this from user input — so it is hashed instead. Those two spaces cannot
 * collide: a derived-from-hash id has a non-zero first group, which a padded
 * ObjectId never does.
 */
export function toDocumentUuid(id: string): string {
  if (isObjectIdLike(id)) {
    const hex = `00000000${id.toLowerCase()}`;
    return formatUuid(hex);
  }
  return formatUuid(hashToHex(id));
}

/** The application id for a KDB document id, or null when it was not derived from one. */
export function fromDocumentUuid(uuid: string): string | null {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (hex.length !== 32 || !hex.startsWith('00000000')) return null;
  return hex.slice(8);
}

function formatUuid(hex32: string): string {
  const h = hex32.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * A 32-hex digest for a non-ObjectId id. Uses SHA-256 truncated to 16 bytes, with
 * the first byte forced non-zero so the result can never look like a padded
 * ObjectId.
 */
function hashToHex(value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes.toString('hex');
}
