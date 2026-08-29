import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config/index.js';
import type { McpOAuthScope } from './constants.js';

export interface McpOAuthAccessTokenPayload {
  sub: string;
  scope: string;
  client_id: string;
  aud: string;
  typ: 'mcp_oauth';
}

export function signMcpOAuthAccessToken(payload: {
  userId: string;
  scopes: McpOAuthScope[];
  clientId: string;
  resource: string;
}): string {
  const claims: McpOAuthAccessTokenPayload = {
    sub: payload.userId,
    scope: payload.scopes.join(' '),
    client_id: payload.clientId,
    aud: payload.resource,
    typ: 'mcp_oauth',
  };
  const options: SignOptions = { expiresIn: config.mcpOAuth.accessTokenTtlSec };
  return jwt.sign(claims, config.mcpOAuth.jwtSecret, options);
}

export function verifyMcpOAuthAccessToken(token: string): McpOAuthAccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.mcpOAuth.jwtSecret, {
      algorithms: ['HS256'],
    }) as McpOAuthAccessTokenPayload;
    if (decoded.typ !== 'mcp_oauth') return null;
    if (!decoded.sub || !decoded.client_id || !decoded.aud) return null;
    return decoded;
  } catch {
    return null;
  }
}
