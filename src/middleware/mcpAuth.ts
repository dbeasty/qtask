import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';
import { verifyMcpOAuthAccessToken } from '../oauth/jwt.js';
import { buildMcpAuthChallengeHeader } from '../oauth/metadata.js';
import { getMcpCloudResourceUri, getMcpResourceUri } from '../config/urls.js';
import { mcpKeyService } from '../services/mcpKeyService.js';
import { mcpOAuthService } from '../services/mcpOAuthService.js';
import type { McpKeyScope } from '../types/mcp.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mcpAuth');

declare global {
  namespace Express {
    interface Request {
      mcpAuth?: {
        userId: string;
        scope: McpKeyScope;
        authMethod: 'api_key' | 'oauth';
        keyId?: string;
        clientId?: string;
      };
    }
  }
}

function sendMcpUnauthorized(res: Response, reason: string): void {
  logger.info('MCP auth failed', { reason });
  if (config.mcpOAuth.enabled) {
    res.setHeader('WWW-Authenticate', buildMcpAuthChallengeHeader());
    res.status(401).json({ error: 'MCP authorization required' });
    return;
  }
  res.status(401).json({ error: 'MCP API key required' });
}

function oauthKeyId(clientId: string): string {
  return `oauth:${clientId}`;
}

export async function requireMcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendMcpUnauthorized(res, 'missing_token');
    return;
  }

  const rawToken = authHeader.slice(7).trim();
  if (!rawToken) {
    sendMcpUnauthorized(res, 'empty_token');
    return;
  }

  if (rawToken.startsWith('qtk_')) {
    const auth = await mcpKeyService.authenticate(rawToken);
    if (!auth) {
      sendMcpUnauthorized(res, 'invalid_key');
      return;
    }
    req.mcpAuth = {
      userId: auth.userId,
      scope: auth.scope,
      authMethod: 'api_key',
      keyId: auth.keyId,
    };
    next();
    return;
  }

  if (config.mcpOAuth.enabled) {
    const payload = verifyMcpOAuthAccessToken(rawToken);
    if (payload) {
      const allowedResources = new Set([getMcpResourceUri(), getMcpCloudResourceUri()]);
      if (!allowedResources.has(payload.aud)) {
        sendMcpUnauthorized(res, 'invalid_audience');
        return;
      }
      req.mcpAuth = {
        userId: payload.sub,
        scope: mcpOAuthService.mapAccessTokenScope(payload.scope),
        authMethod: 'oauth',
        clientId: payload.client_id,
        keyId: oauthKeyId(payload.client_id),
      };
      next();
      return;
    }
  }

  sendMcpUnauthorized(res, 'invalid_token');
}

export async function optionalMcpAuthChallenge(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendMcpUnauthorized(res, 'missing_token');
    return;
  }
  await requireMcpAuth(req, res, next);
}
