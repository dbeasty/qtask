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

function findInMemorySession(userId: string, keyId: string): SessionEntry | undefined {
  for (const entry of sessions.values()) {
    if (entry.ctx.userId === userId && entry.ctx.keyId === keyId) {
      return entry;
    }
  }
  return undefined;
}

async function buildSessionEntry(
  userId: string,
  keyId: string,
  scope: McpServerContext['scope'],
  sessionId: string,
  isNewMongoSession: boolean
): Promise<SessionEntry> {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );

  if (isNewMongoSession) {
    await mcpSessionService.createSession(userId, keyId, sessionId);
  } else {
    await mcpSessionService.touchSession(userId, sessionId);
  }

  const mongoSession = await mcpSessionService.getSessionByKey(userId, keyId, sessionId);
  const ctx: McpServerContext = {
    userId,
    sessionId,
    scope,
    keyId,
    activeProjectId: mongoSession?.activeProjectId ?? undefined,
  };

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessionclosed: async (id) => {
      sessions.delete(id);
      log.info('MCP transport closed (session persisted)', { sessionId: id, userId, keyId });
    },
  });

  const server = await createMcpServer(ctx);
  await server.connect(transport);

  const entry: SessionEntry = { transport, server, ctx };
  sessions.set(sessionId, entry);
  return entry;
}

async function getOrCreateSessionEntry(
  userId: string,
  keyId: string,
  scope: McpServerContext['scope'],
  existingSessionId?: string
): Promise<{ entry: SessionEntry; reused: boolean; source?: 'memory' | 'mongo' }> {
  if (existingSessionId) {
    const mongoSession = await mcpSessionService.getSessionByKey(userId, keyId, existingSessionId);
    if (!mongoSession) {
      throw new Error('MCP session not found');
    }

    sessions.delete(existingSessionId);
    const entry = await buildSessionEntry(userId, keyId, scope, existingSessionId, false);
    return { entry, reused: true, source: 'mongo' };
  }

  const sessionId = randomUUID();
  const entry = await buildSessionEntry(userId, keyId, scope, sessionId, true);
  return { entry, reused: false };
}

export async function handleMcpHttpRequest(req: Request, res: Response): Promise<void> {
  if (!req.mcpAuth?.keyId) {
    res.status(401).json({ error: 'MCP authorization required' });
    return;
  }

  const sessionHeader = req.headers['mcp-session-id'];
  const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
  const { userId, keyId, scope } = req.mcpAuth;

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

    if (sessionId && !sessions.has(sessionId)) {
      const mongoSession = await mcpSessionService.getSessionByKey(userId, keyId, sessionId);
      if (mongoSession) {
        const { entry } = await getOrCreateSessionEntry(userId, keyId, scope, sessionId);
        log.info('MCP session rehydrated', { userId, keyId, sessionId: entry.ctx.sessionId });
        await entry.transport.handleRequest(
          req as unknown as IncomingMessage,
          res as ServerResponse,
          req.body
        );
        return;
      }
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const inMemory = findInMemorySession(userId, keyId);
      if (inMemory) {
        sessions.delete(inMemory.ctx.sessionId);
      }

      const reusableSessionId =
        inMemory?.ctx.sessionId ??
        (await mcpSessionService.findReusableMongoSession(userId, keyId));

      const { entry, reused, source } = reusableSessionId
        ? await getOrCreateSessionEntry(userId, keyId, scope, reusableSessionId)
        : await getOrCreateSessionEntry(userId, keyId, scope);

      if (reused) {
        log.info('MCP session reused', {
          userId,
          keyId,
          sessionId: entry.ctx.sessionId,
          source: source ?? (inMemory ? 'memory' : 'mongo'),
        });
      } else {
        log.info('MCP session initialized', {
          userId,
          keyId,
          sessionId: entry.ctx.sessionId,
        });
      }
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

export function _getMcpSessionsForTests(): Map<string, SessionEntry> {
  return sessions;
}

export function _closeMcpTransportForTests(sessionId: string): void {
  sessions.delete(sessionId);
}
