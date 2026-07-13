import { config } from '../config/index.js';
import { toolDefinitions, executeTool } from '../agent/tools.js';
import { connectDb } from '../db/connection.js';
import { startEmbeddingWorker } from '../services/embeddingQueue.js';
import { resolveAuthUserId } from '../middleware/auth.js';
import { APP_VERSION } from '../version.js';

export async function resolveMcpUserId(): Promise<string> {
  const token = process.env.MCP_JWT;
  if (!token) {
    throw new Error('MCP_JWT environment variable is required. Log in via the web client and copy your JWT.');
  }
  return resolveAuthUserId(token);
}

export async function createMcpServer(userId: string): Promise<import('@modelcontextprotocol/sdk/server/mcp.js').McpServer> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({
    name: 'qtask',
    version: APP_VERSION,
  });

  for (const tool of toolDefinitions) {
    server.tool(tool.name, tool.description, tool.zodShape, async (input) => {
      const result = await executeTool(tool.name, input as Record<string, unknown>, userId);
      return {
        content: [{ type: 'text', text: result.text }],
        isError: !result.success,
      };
    });
  }

  return server;
}

export async function startMcpServer(): Promise<void> {
  await connectDb();
  startEmbeddingWorker();

  const userId = await resolveMcpUserId();
  const server = await createMcpServer(userId);
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
