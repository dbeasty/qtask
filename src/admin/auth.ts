import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config/index.js';
import { verifyPassword } from '../utils/passwordHash.js';

const COOKIE_NAME = 'qtask_admin';

interface AdminToken {
  sub: string;
  purpose: 'admin';
  csrf: string;
}

function equalSecret(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const index = part.indexOf('=');
      if (index < 0) return [part.trim(), ''];
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
    })
  );
}

function readToken(req: Request): AdminToken | null {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.admin.jwtSecret) as AdminToken;
    return payload.purpose === 'admin' ? payload : null;
  } catch {
    return null;
  }
}

function adminFeatures() {
  return { deleteConfirmEmail: config.admin.deleteConfirmEmail };
}

function issueSession(
  res: Response,
  identity: string
): { identity: string; csrfToken: string; features: { deleteConfirmEmail: boolean } } {
  const csrfToken = randomBytes(24).toString('base64url');
  const options: SignOptions = { expiresIn: '1h' };
  const token = jwt.sign(
    { sub: identity, purpose: 'admin', csrf: csrfToken } satisfies AdminToken,
    config.admin.jwtSecret,
    options
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.admin.cookieSecure,
    sameSite: 'strict',
    maxAge: 60 * 60 * 1000,
    path: '/api/admin',
  });
  return { identity, csrfToken, features: adminFeatures() };
}

export async function passwordLogin(req: Request, res: Response): Promise<void> {
  if (config.admin.authMode !== 'password') {
    res.status(404).json({ error: 'Password login is disabled' });
    return;
  }

  const submitted = req.body?.password as string | undefined;
  let valid = false;
  if (config.admin.hashAdminPassword) {
    valid = await verifyPassword(submitted ?? '', config.admin.passwordHash ?? '');
  } else {
    valid = equalSecret(submitted, config.admin.password);
  }

  if (!valid) {
    res.status(401).json({ error: 'Invalid admin credentials' });
    return;
  }
  res.json(issueSession(res, 'password-admin'));
}

export function mtlsLogin(req: Request, res: Response): void {
  if (config.admin.authMode !== 'mtls') {
    res.status(404).json({ error: 'Client-certificate login is disabled' });
    return;
  }
  const proxySecret = req.header('x-admin-proxy-secret');
  const verified = req.header('x-ssl-client-verify');
  const identity = req.header('x-ssl-client-dn');
  if (!equalSecret(proxySecret, config.admin.proxySecret) || verified !== 'SUCCESS' || !identity) {
    res.status(401).json({ error: 'A verified client certificate is required' });
    return;
  }
  res.json(issueSession(res, identity.slice(0, 300)));
}

export function adminSession(req: Request, res: Response): void {
  const token = readToken(req);
  res.json({
    authenticated: token !== null,
    authMode: config.admin.authMode,
    identity: token?.sub,
    csrfToken: token?.csrf,
    features: adminFeatures(),
  });
}

export function adminLogout(_req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: config.admin.cookieSecure,
    sameSite: 'strict',
    path: '/api/admin',
  });
  res.status(204).end();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = readToken(req);
  if (!token) {
    res.status(401).json({ error: 'Admin authentication required' });
    return;
  }
  req.admin = { identity: token.sub };
  next();
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const token = readToken(req);
  const submitted = req.header('x-csrf-token');
  if (!token || !equalSecret(submitted, token.csrf)) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return;
  }
  next();
}
