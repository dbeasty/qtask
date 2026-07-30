import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type McpServerContext } from './server.js';
import { mcpSessionService } from '../services/mcpSessionService.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcpHttp');

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  ctx: McpServerContext;
}

const sessions = new Map<string, SessionEntry>();

function isInitializeRequest(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (message) =>
      message &&
      typeof message === 'object' &&
      'method' in message &&
      (message as { method?: string }).method === 'initialize'
  );
}

async function createSessionEntry(
  userId: string,
  keyId: string,
  scope: McpServerContext['scope']
): Promise<SessionEntry> {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

  const sessionId = randomUUID();
  await mcpSessionService.createSession(userId, keyId, sessionId);

  const ctx: McpServerContext = {
    userId,
    sessionId,
    scope,
    keyId,
  };

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessionclosed: async (id) => {
      const entry = sessions.get(id);
      if (entry) {
        await mcpSessionService.closeSession(entry.ctx.userId, entry.ctx.sessionId).catch(() => {});
        sessions.delete(id);
      }
    },
  });

  const server = await createMcpServer(ctx);
  await server.connect(transport);

  const entry: SessionEntry = { transport, server, ctx };
  sessions.set(sessionId, entry);
  return entry;
}

export async function handleMcpHttpRequest(req: Request, res: Response): Promise<void> {
  if (!req.mcpAuth?.keyId) {
    res.status(401).json({ error: 'MCP authorization required' });
    return;
  }

  const sessionHeader = req.headers['mcp-session-id'];
  const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;

  try {
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      const session = await mcpSessionService.getSession(entry.ctx.userId, entry.ctx.sessionId);
      entry.ctx.activeProjectId = session?.activeProjectId ?? undefined;
      await mcpSessionService.touchSession(entry.ctx.userId, entry.ctx.sessionId);
      await entry.transport.handleRequest(
        req as unknown as IncomingMessage,
        res as ServerResponse,
        req.body
      );
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const entry = await createSessionEntry(
        req.mcpAuth.userId,
        req.mcpAuth.keyId,
        req.mcpAuth.scope
      );
      log.info('MCP session initialized', {
        userId: req.mcpAuth.userId,
        keyId: req.mcpAuth.keyId,
        sessionId: entry.ctx.sessionId,
      });
      await entry.transport.handleRequest(
        req as unknown as IncomingMessage,
        res as ServerResponse,
        req.body
      );
      return;
    }

    res.status(400).json({
      error: 'Invalid or missing MCP session. Send an initialize request without mcp-session-id first.',
    });
  } catch (error) {
    log.error('MCP request failed', {
      error: error instanceof Error ? error.message : String(error),
      userId: req.mcpAuth.userId,
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP request failed' });
    }
  }
}

export function _resetMcpSessionsForTests(): void {
  sessions.clear();
}
