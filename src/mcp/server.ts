import { z } from 'zod';
import { toolDefinitions } from '../agent/tools.js';
import { loadAgentContext, loadMcpPromptWithProject } from '../agent/loadContext.js';
import { APP_VERSION } from '../version.js';
import {
  executeMcpTool,
  isMcpRegisteredTool,
  mcpInternalToolDefinitions,
  type McpServerContext,
} from './mcpToolHandler.js';

export type { McpServerContext };

export async function createMcpServer(ctx: McpServerContext): Promise<import('@modelcontextprotocol/sdk/server/mcp.js').McpServer> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({
    name: 'qtask',
    version: APP_VERSION,
  });

  const registerTool = (
    name: string,
    description: string,
    zodShape: z.ZodRawShape,
    handler: (input: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>
  ) => {
    server.tool(name, description, zodShape, async (input) => handler(input as Record<string, unknown>));
  };

  for (const tool of toolDefinitions) {
    if (!isMcpRegisteredTool(tool.name)) continue;
    registerTool(tool.name, tool.description, tool.zodShape, async (input) => {
      const result = await executeMcpTool(ctx, tool.name, input);
      return {
        content: [{ type: 'text', text: result.text }],
        isError: !result.success,
      };
    });
  }

  for (const tool of mcpInternalToolDefinitions) {
    registerTool(tool.name, tool.description, tool.zodShape, async (input) => {
      const result = await executeMcpTool(ctx, tool.name, input);
      return {
        content: [{ type: 'text', text: result.text }],
        isError: !result.success,
      };
    });
  }

  const basePrompt = loadAgentContext('mcp');
  server.prompt('qtask-system', 'QTask system instructions for external MCP clients', async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: basePrompt } }],
  }));

  server.prompt(
    'qtask-system-with-project',
    'QTask system instructions including the active project for this session',
    async () => {
      let text = basePrompt;
      if (ctx.activeProjectId) {
        const { projectService } = await import('../services/projectService.js');
        const project = await projectService.getProject(ctx.userId, ctx.activeProjectId);
        if (project) {
          text = loadMcpPromptWithProject(project.name, ctx.activeProjectId);
        }
      }
      return {
        messages: [{ role: 'user', content: { type: 'text', text } }],
      };
    }
  );

  server.registerResource(
    'active-project',
    'qtask://active-project',
    {
      title: 'Active project',
      description: 'Current active project id and name for this MCP session',
      mimeType: 'application/json',
    },
    async () => {
      if (!ctx.activeProjectId) {
        return {
          contents: [
            {
              uri: 'qtask://active-project',
              mimeType: 'application/json',
              text: JSON.stringify({ activeProjectId: null }),
            },
          ],
        };
      }
      const { projectService } = await import('../services/projectService.js');
      const project = await projectService.getProject(ctx.userId, ctx.activeProjectId);
      return {
        contents: [
          {
            uri: 'qtask://active-project',
            mimeType: 'application/json',
            text: JSON.stringify({
              activeProjectId: ctx.activeProjectId,
              name: project?.name ?? null,
            }),
          },
        ],
      };
    }
  );

  return server;
}

export async function resolveMcpUserId(): Promise<string> {
  const token = process.env.MCP_JWT;
  if (!token) {
    throw new Error('MCP_JWT environment variable is required. Log in via the web client and copy your JWT.');
  }
  const { resolveAuthUserId } = await import('../middleware/auth.js');
  return resolveAuthUserId(token);
}

export async function startMcpServer(): Promise<void> {
  const { connectDb } = await import('../db/connection.js');
  const { startEmbeddingWorker } = await import('../services/embeddingQueue.js');
  const { randomUUID } = await import('node:crypto');
  const { mcpSessionService } = await import('../services/mcpSessionService.js');

  await connectDb();
  startEmbeddingWorker();

  const userId = await resolveMcpUserId();
  const sessionId = randomUUID();
  await mcpSessionService.createSession(userId, 'stdio-local');

  const server = await createMcpServer({
    userId,
    sessionId,
    scope: 'read_write',
  });

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
