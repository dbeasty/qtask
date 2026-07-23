import bcrypt from 'bcryptjs';

export const BCRYPT_ROUNDS = 12;

const BCRYPT_HASH_PREFIX = /^\$2[aby]\$/;

export function isBcryptHash(value: string | undefined): boolean {
  return typeof value === 'string' && BCRYPT_HASH_PREFIX.test(value);
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
