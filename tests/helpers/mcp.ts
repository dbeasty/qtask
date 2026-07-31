import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import type { McpServerContext } from '../../src/mcp/mcpToolHandler.js';
import type { McpKeyScope } from '../../src/types/mcp.js';

export async function registerUser(email: string) {
  const { UserModel } = await import('../../src/models/index.js');
  const user = await UserModel.create({
    email,
    passwordHash: 'unused',
    emailVerified: true,
  });
  const { signToken } = await import('../../src/auth/jwt.js');
  return {
    userId: String(user._id),
    jwt: signToken({ sub: String(user._id), email }),
  };
}

export async function createMcpContext(scope: McpKeyScope = 'read_write') {
  const { userId } = await registerUser(`mcp-${randomUUID()}@example.com`);
  const { mcpKeyService } = await import('../../src/services/mcpKeyService.js');
  const { mcpSessionService } = await import('../../src/services/mcpSessionService.js');

  const { secret } = await mcpKeyService.createKey(userId, 'test key', scope);
  const auth = await mcpKeyService.authenticate(secret);
  assert.ok(auth);

  const sessionId = await mcpSessionService.createSession(userId, auth.keyId, randomUUID());
  const ctx: McpServerContext = {
    userId,
    sessionId,
    scope,
    keyId: auth.keyId,
  };

  return { ctx, userId, secret, sessionId };
}

export function parseProposal(text: string): {
  proposalId: string;
  tool?: string;
  preview?: { _id?: string };
  stagedEntity?: { id?: string; kind?: string };
  [key: string]: unknown;
} {
  const parsed = JSON.parse(text) as { proposalId?: string };
  assert.ok(parsed.proposalId, `Expected proposalId in: ${text}`);
  return parsed as { proposalId: string; tool?: string; [key: string]: unknown };
}

export function parseToolResult(text: string): Record<string, unknown> {
  const clean = text.split('\n\nSTAGED:')[0]?.trim() ?? text.trim();
  return JSON.parse(clean) as Record<string, unknown>;
}

export async function refreshActiveProject(ctx: McpServerContext): Promise<void> {
  const { mcpSessionService } = await import('../../src/services/mcpSessionService.js');
  const session = await mcpSessionService.getSession(ctx.userId, ctx.sessionId);
  ctx.activeProjectId = session?.activeProjectId ?? undefined;
}

export async function callMcpTool(
  ctx: McpServerContext,
  name: string,
  args: Record<string, unknown> = {}
) {
  await refreshActiveProject(ctx);
  const { executeMcpTool } = await import('../../src/mcp/mcpToolHandler.js');
  return executeMcpTool(ctx, name, args);
}

export async function stageWrite(
  ctx: McpServerContext,
  tool: string,
  args: Record<string, unknown>
): Promise<string> {
  const { proposalId } = await stageWriteWithMeta(ctx, tool, args);
  return proposalId;
}

export async function stageWriteWithMeta(
  ctx: McpServerContext,
  tool: string,
  args: Record<string, unknown>
) {
  const result = await callMcpTool(ctx, tool, args);
  assert.equal(result.success, true, result.text);
  const parsed = parseProposal(result.text);
  return { proposalId: parsed.proposalId, staged: parsed };
}

function stagedEntityId(staged: { preview?: unknown; stagedEntity?: { id?: string } }): string {
  const preview = staged.preview as { _id?: string } | undefined;
  const id = staged.stagedEntity?.id ?? preview?._id;
  assert.ok(id, `Expected staged entity id in proposal: ${JSON.stringify(staged)}`);
  return id;
}

export async function approve(ctx: McpServerContext, proposalId: string): Promise<string> {
  const result = await callMcpTool(ctx, 'approve_proposal', { proposalId });
  assert.equal(result.success, true, result.text);
  return result.text;
}

export async function reject(ctx: McpServerContext, proposalId: string): Promise<string> {
  const result = await callMcpTool(ctx, 'reject_proposal', { proposalId });
  assert.equal(result.success, true, result.text);
  return result.text;
}

export async function commitWrite(
  ctx: McpServerContext,
  tool: string,
  args: Record<string, unknown>
): Promise<string> {
  const proposalId = await stageWrite(ctx, tool, args);
  return approve(ctx, proposalId);
}

export async function commitProject(
  ctx: McpServerContext,
  name: string,
  parentId?: string
): Promise<{ _id: string; name: string }> {
  const { proposalId, staged } = await stageWriteWithMeta(
    ctx,
    'create_project',
    parentId ? { name, parentId } : { name }
  );
  const projectId = stagedEntityId(staged);
  await approve(ctx, proposalId);

  const fetched = await callMcpTool(ctx, 'get_project', { projectId });
  assert.equal(fetched.success, true, fetched.text);
  const project = parseToolResult(fetched.text) as { _id: string; name: string };
  assert.equal(project._id, projectId);
  return project;
}

export async function commitTask(
  ctx: McpServerContext,
  args: Record<string, unknown>
): Promise<{ _id: string; title: string }> {
  const { proposalId, staged } = await stageWriteWithMeta(ctx, 'create_task', args);
  const taskId = stagedEntityId(staged);
  await approve(ctx, proposalId);

  const fetched = await callMcpTool(ctx, 'get_task', { taskId });
  assert.equal(fetched.success, true, fetched.text);
  const task = parseToolResult(fetched.text) as { _id: string; title: string };
  assert.equal(task._id, taskId);
  return task;
}

export function parseSseMessages(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('data: ')) {
      messages.push(JSON.parse(line.slice(6)));
    }
  }
  return messages;
}

export function parseSseResult(body: string): unknown {
  const messages = parseSseMessages(body);
  const last = messages.at(-1) as { result?: unknown; error?: unknown } | undefined;
  if (last?.error) {
    throw new Error(JSON.stringify(last.error));
  }
  return last?.result;
}

export async function mcpRpc(
  app: Express,
  secret: string,
  sessionId: string | undefined,
  method: string,
  params: unknown,
  id = 1
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const res = await request(app)
    .post('/api/mcp')
    .set(headers)
    .buffer(true)
    .parse((response, callback) => {
      let data = '';
      response.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      response.on('end', () => callback(null, data));
    })
    .send({ jsonrpc: '2.0', id, method, params });

  const body = res.body as string;
  return {
    status: res.status,
    sessionId: res.headers['mcp-session-id'] as string | undefined,
    result: parseSseResult(body),
    raw: body,
  };
}

export async function mcpInitialize(app: Express, secret: string): Promise<string> {
  const res = await mcpRpc(app, secret, undefined, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  });
  assert.equal(res.status, 200);
  assert.ok(res.sessionId);
  return res.sessionId;
}

export async function mcpCallTool(
  app: Express,
  secret: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {}
) {
  const res = await mcpRpc(app, secret, sessionId, 'tools/call', {
    name,
    arguments: args,
  });
  assert.equal(res.status, 200);
  const result = res.result as {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const text = result.content?.[0]?.text ?? '';
  return { text, isError: result.isError ?? false, result };
}

export async function resetMcpTestData(): Promise<void> {
  const { UserModel, McpApiKeyModel, McpSessionModel, TaskModel, ProjectModel, CommentModel } =
    await import('../../src/models/index.js');
  await Promise.all([
    UserModel.deleteMany({}),
    McpApiKeyModel.deleteMany({}),
    McpSessionModel.deleteMany({}),
    TaskModel.deleteMany({}),
    ProjectModel.deleteMany({}),
    CommentModel.deleteMany({}),
  ]);
  const { _resetMcpSessionsForTests } = await import('../../src/mcp/httpHandler.js');
  _resetMcpSessionsForTests();
}
