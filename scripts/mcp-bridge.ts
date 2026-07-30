#!/usr/bin/env node
/**
 * Stdio MCP bridge to a remote QTask Streamable HTTP MCP endpoint (e.g. https://qtask.dev/api/mcp).
 *
 * Env:
 *   QTASK_MCP_URL  — default https://qtask.dev/api/mcp
 *   QTASK_MCP_KEY  — required MCP API key (qtk_…)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const url = process.env.QTASK_MCP_URL ?? 'https://qtask.dev/api/mcp';
const key = process.env.QTASK_MCP_KEY;

if (!key) {
  console.error('QTASK_MCP_KEY is required (create one in QTask account settings).');
  process.exit(1);
}

async function main(): Promise<void> {
  const client = new Client({ name: 'qtask-mcp-bridge', version: '0.1.0' });
  const remoteTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${key}`,
      },
    },
  });

  await client.connect(remoteTransport);

  const local = new McpServer({ name: 'qtask', version: '0.1.0' });

  const tools = await client.listTools();
  for (const tool of tools.tools) {
    const shape: z.ZodRawShape = {};
    const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    if (props) {
      for (const name of Object.keys(props)) {
        shape[name] = z.any().optional();
      }
    }

    local.tool(tool.name, tool.description ?? tool.name, shape, async (args) => {
      const result = await client.callTool({ name: tool.name, arguments: args });
      return result as { content: { type: 'text'; text: string }[]; isError?: boolean };
    });
  }

  const prompts = await client.listPrompts();
  for (const prompt of prompts.prompts) {
    local.prompt(prompt.name, prompt.description ?? prompt.name, async () => {
      const result = await client.getPrompt({ name: prompt.name, arguments: {} });
      return {
        messages: result.messages.map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: message.content,
        })),
      };
    });
  }

  const resources = await client.listResources();
  for (const resource of resources.resources) {
    local.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async () => {
        const result = await client.readResource({ uri: resource.uri });
        return result;
      }
    );
  }

  const stdio = new StdioServerTransport();
  await local.connect(stdio);
}

main().catch((error) => {
  console.error('MCP bridge failed:', error);
  process.exit(1);
});
