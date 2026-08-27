import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isReadOnlyMode(): boolean {
  return process.env.READ_ONLY_MODE === 'true';
}

function deploymentPhase(): string {
  const phase = process.env.DEPLOYMENT_PHASE;
  if (phase === 'major-deploy' || phase === 'candidate') return phase;
  return 'normal';
}

/** Auth endpoints stay available so users can sign in and refresh during major deploys. */
function isAuthWriteAllowed(req: Request): boolean {
  if (!req.path.startsWith('/api/auth')) return false;
  return req.method === 'POST' || req.method === 'PATCH';
}

export function readOnlyMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isReadOnlyMode()) {
    next();
    return;
  }

  if (!MUTATING.has(req.method)) {
    next();
    return;
  }

  if (req.path === '/health' || isAuthWriteAllowed(req)) {
    next();
    return;
  }

  // MCP multiplexes its entire protocol (handshake + every tool call, both
  // reads and writes) through a single POST endpoint, so gating by HTTP
  // method here would block read-only tools too — mcpToolHandler.ts
  // already does the correct per-tool read/write check before dispatch.
  if (req.path === '/api/mcp' || req.path.startsWith('/api/mcp/')) {
    next();
    return;
  }

  const message = config.deployment.message;
  res.status(503).json({
    error: message,
    readOnly: true,
    message,
  });
}

export function getDeploymentHealthPayload(): {
  readOnly: boolean;
  phase: string;
  message: string;
} {
  return {
    readOnly: isReadOnlyMode(),
    phase: deploymentPhase(),
    message: config.deployment.message,
  };
}
