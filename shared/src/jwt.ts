// Pure-JS base64url JWT payload decode (no `atob` dependency), so this works
// identically on web and React Native/Hermes.
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Decode(input: string): string {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  let output = '';
  for (let i = 0; i < clean.length; i += 4) {
    const chunk = clean.slice(i, i + 4);
    const bits = chunk
      .split('')
      .map((char) => BASE64_CHARS.indexOf(char).toString(2).padStart(6, '0'))
      .join('');
    for (let j = 0; j + 8 <= bits.length; j += 8) {
      output += String.fromCharCode(parseInt(bits.slice(j, j + 8), 2));
    }
  }
  return output;
}

export interface TokenPayload {
  sub?: string;
  exp?: number;
}

export function decodeTokenPayload(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = base64Decode(normalized);
    const payload = JSON.parse(decodeURIComponent(escape(json))) as TokenPayload;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function getTokenExpiryMs(token: string): number | null {
  const payload = decodeTokenPayload(token);
  if (!payload?.exp) return null;
  return payload.exp * 1000;
}

export function isTokenExpired(token: string | null): boolean {
  if (!token) return false;
  const expMs = getTokenExpiryMs(token);
  if (expMs == null) return false;
  return Date.now() >= expMs;
}

export const REFRESH_LEAD_MS = 24 * 60 * 60 * 1000;
export const REFRESH_GRACE_MS = 5 * 60 * 1000;

export function isWithinRefreshGrace(token: string | null): boolean {
  if (!token) return false;
  const expMs = getTokenExpiryMs(token);
  if (expMs == null) return false;
  return Date.now() >= expMs && Date.now() - expMs <= REFRESH_GRACE_MS;
}

export function shouldProactivelyRefresh(token: string | null): boolean {
  if (!token) return false;
  const expMs = getTokenExpiryMs(token);
  if (expMs == null) return false;
  return Date.now() >= expMs - REFRESH_LEAD_MS;
}
