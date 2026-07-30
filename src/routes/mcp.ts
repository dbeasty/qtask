import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';
import { buildMcpAuthChallengeHeader } from '../oauth/metadata.js';
import { requireMcpAuth } from '../middleware/mcpAuth.js';
import { handleMcpHttpRequest } from '../mcp/httpHandler.js';

export const mcpRouter = Router();

const mcpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.nodeEnv === 'production' ? 120 : 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many MCP requests, please try again later' },
});

function sendUnauthorizedDiscovery(res: import('express').Response): void {
  if (config.mcpOAuth.enabled) {
    res.setHeader('WWW-Authenticate', buildMcpAuthChallengeHeader());
  }
  res.status(401).json({ error: 'MCP authorization required' });
}

mcpRouter.post('/', mcpLimiter, requireMcpAuth, (req, res, next) => {
  void handleMcpHttpRequest(req, res).catch(next);
});

mcpRouter.get('/', mcpLimiter, (req, res, next) => {
  if (!req.headers.authorization) {
    sendUnauthorizedDiscovery(res);
    return;
  }
  void requireMcpAuth(req, res, () => {
    res.status(405).json({ error: 'Use POST for MCP Streamable HTTP requests' });
  }).catch(next);
});
