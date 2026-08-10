import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../config/index.js';
import type { IdentityProviderId, OAuthStatePayload } from './types.js';
import { isIdentityProviderId } from './types.js';

const STATE_TTL_MS = 10 * 60 * 1000;

function signPayload(encoded: string): string {
  return createHmac('sha256', config.jwtSecret).update(encoded).digest('base64url');
}

function encodePayload(payload: OAuthStatePayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodePayload(encoded: string): OAuthStatePayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!isIdentityProviderId(parsed.provider)) return null;
    if (typeof parsed.nonce !== 'string' || typeof parsed.pkceCodeVerifier !== 'string') return null;
    if (typeof parsed.exp !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createOAuthState(input: {
  provider: IdentityProviderId;
  pkceCodeVerifier: string;
  returnTo?: string;
  inviteToken?: string;
  acceptLegal?: boolean;
}): string {
  const payload: OAuthStatePayload = {
    provider: input.provider,
    nonce: randomBytes(16).toString('hex'),
    pkceCodeVerifier: input.pkceCodeVerifier,
    returnTo: input.returnTo,
    inviteToken: input.inviteToken,
    acceptLegal: input.acceptLegal === true ? true : undefined,
    exp: Date.now() + STATE_TTL_MS,
  };
  const encoded = encodePayload(payload);
  return `${encoded}.${signPayload(encoded)}`;
}

export function verifyOAuthState(state: string): OAuthStatePayload | null {
  const parts = state.split('.');
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
