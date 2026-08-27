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
    const cachedEntry = sessionId ? sessions.get(sessionId) : undefined;
    if (cachedEntry && (cachedEntry.ctx.userId !== userId || cachedEntry.ctx.keyId !== keyId)) {
      res.status(401).json({ error: 'MCP authorization required' });
      return;
    }

    if (sessionId && cachedEntry) {
      const entry = cachedEntry;
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

    if (sessionId && !cachedEntry) {
      const mongoSession = await mcpSessionService.getSessionByKey(userId, keyId, sessionId);
      if (mongoSession) {
        // A rehydrated session gets a brand-new transport instance, and the
        // SDK's transport only accepts an initialize request until it has
        // processed one itself (its "initialized" flag is per-instance, not
        // resumable) — so only an initialize request can actually be served
        // here. Anything else would hit the SDK's own opaque 400. Respond
        // 404 instead: per the MCP spec, that tells a compliant client its
        // session is gone and it should send a fresh initialize.
        if (!isInitializeRequest(req.body)) {
          log.info('MCP session known but not resumable without re-initialize', {
            userId,
            keyId,
            sessionId,
          });
          res.status(404).json({ error: 'MCP session expired; send a new initialize request.' });
          return;
        }

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
      // A fresh initialize (no session header) means a new client
      // connection — it must never steal a session that's still live in
      // this process's `sessions` map, since two independent clients can
      // legitimately share one API key concurrently (e.g. Claude Desktop
      // and Cursor). Only reuse a Mongo-recorded session that isn't
      // currently live, so a genuinely idle/rehydrated session still
      // carries its pending-proposal history forward without evicting
      // (and silently corrupting) another client's active connection.
      const candidateSessionId = await mcpSessionService.findReusableMongoSession(userId, keyId);
      const reusableSessionId =
        candidateSessionId && !sessions.has(candidateSessionId) ? candidateSessionId : undefined;

      const { entry, reused, source } = reusableSessionId
        ? await getOrCreateSessionEntry(userId, keyId, scope, reusableSessionId)
        : await getOrCreateSessionEntry(userId, keyId, scope);

      if (reused) {
        log.info('MCP session reused', {
          userId,
          keyId,
          sessionId: entry.ctx.sessionId,
          source,
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
