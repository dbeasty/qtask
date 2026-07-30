import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string | undefined
): boolean {
  if (method !== 'S256') return false;
  if (!codeVerifier || !codeChallenge) return false;
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  try {
    const a = Buffer.from(computed);
    const b = Buffer.from(codeChallenge);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
