import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../config/index.js';
import type { IdentityProviderId } from './types.js';
import { isIdentityProviderId } from './types.js';

const LINK_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const PURPOSE = 'oauth_link_confirmation';

export interface LinkConfirmationPayload {
  purpose: typeof PURPOSE;
  userId: string;
  provider: IdentityProviderId;
  providerUserId: string;
  displayName?: string;
  nonce: string;
  exp: number;
}

function signPayload(encoded: string): string {
  return createHmac('sha256', config.jwtSecret).update(encoded).digest('base64url');
}

function encodePayload(payload: LinkConfirmationPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodePayload(encoded: string): LinkConfirmationPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as LinkConfirmationPayload;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.purpose !== PURPOSE) return null;
    if (typeof parsed.userId !== 'string' || !parsed.userId) return null;
    if (!isIdentityProviderId(parsed.provider)) return null;
    if (typeof parsed.providerUserId !== 'string' || !parsed.providerUserId) return null;
    if (typeof parsed.exp !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createLinkConfirmationToken(input: {
  userId: string;
  provider: IdentityProviderId;
  providerUserId: string;
  displayName?: string;
}): string {
  const payload: LinkConfirmationPayload = {
    purpose: PURPOSE,
    userId: input.userId,
    provider: input.provider,
    providerUserId: input.providerUserId,
    displayName: input.displayName,
    nonce: randomBytes(16).toString('hex'),
    exp: Date.now() + LINK_CONFIRMATION_TTL_MS,
  };
  const encoded = encodePayload(payload);
  return `${encoded}.${signPayload(encoded)}`;
}

export function verifyLinkConfirmationToken(token: string): LinkConfirmationPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const expected = signPayload(encoded);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  const payload = decodePayload(encoded);
  if (!payload || payload.exp < Date.now()) return null;
  return payload;
}
