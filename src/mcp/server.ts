import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from '../config/index.js';
import { toolDefinitions, executeTool } from '../agent/tools.js';
import { connectDb } from '../db/connection.js';
import { startEmbeddingWorker } from '../services/embeddingQueue.js';

export async function createMcpServer(userId = config.defaultUserId): Promise<McpServer> {
  const server = new McpServer({
    name: 'qtask',
    version: '0.1.0',
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

  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
