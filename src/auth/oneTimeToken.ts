import { createHash, randomBytes } from 'node:crypto';

export interface OneTimeToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createOneTimeToken(ttlMs: number): OneTimeToken {
  const token = randomBytes(32).toString('hex');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  };
}
