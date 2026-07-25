import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config/index.js';

export interface JwtPayload {
  sub: string;
  email: string;
  pwd_change?: boolean;
}

export function signToken(payload: JwtPayload): string {
  const options: SignOptions = { expiresIn: config.jwtExpiresIn as SignOptions['expiresIn'] };
  return jwt.sign(payload, config.jwtSecret, options);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtSecret) as JwtPayload;
}

export interface UnsafeTokenMetadata {
  sub?: string;
  exp?: number;
  error?: string;
}

/** Decode JWT payload without verification — for logging metadata only. */
export function decodeTokenUnsafe(token: string): UnsafeTokenMetadata {
  try {
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded === 'string') {
      return { error: 'invalid_payload' };
    }
    return {
      sub: typeof decoded.sub === 'string' ? decoded.sub : undefined,
      exp: typeof decoded.exp === 'number' ? decoded.exp : undefined,
    };
  } catch {
    return { error: 'decode_failed' };
  }
}
