import { z } from 'zod';
import { executeTool } from '../agent/tools.js';
import type { ToolResult } from '../agent/tools.js';
import type { McpKeyScope } from '../types/mcp.js';
import { mcpSessionService } from '../services/mcpSessionService.js';
import {
  isReadOnlyMode,
  MCP_INTERNAL_TOOLS,
  MCP_READ_TOOLS,
  MCP_WRITE_TOOLS,
} from './toolGroups.js';

export interface McpServerContext {
  userId: string;
  sessionId: string;
  scope: McpKeyScope;
  activeProjectId?: string;
  keyId?: string;
}

function ok(text: string): ToolResult {
  return { success: true, text };
}

function err(text: string): ToolResult {
  return { success: false, text };
}

function readOnlyBlocked(name: string): ToolResult | null {
  if (!isReadOnlyMode()) return null;
  if (MCP_READ_TOOLS.has(name)) return null;
  return err('QTask is in read-only mode; write operations are temporarily disabled.');
}

function scopeBlocked(name: string, scope: McpKeyScope): ToolResult | null {
  if (scope === 'read_write') return null;
  if (MCP_READ_TOOLS.has(name) || name === 'list_pending_proposals') return null;
  return err('This MCP key is read-only. Create a read_write key to modify data.');
}

export async function executeMcpTool(
  ctx: McpServerContext,
  name: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const readOnly = readOnlyBlocked(name);
  if (readOnly) return readOnly;

  const scope = scopeBlocked(name, ctx.scope);
  if (scope) return scope;

  if (name === 'set_active_project') {
    const projectId = String(input.projectId ?? '');
    if (!/^[0-9a-f]{24}$/i.test(projectId)) {
      return err('projectId must be a 24-character hex id');
    }
    try {
      await mcpSessionService.setActiveProject(ctx.userId, ctx.sessionId, projectId);
      return ok(JSON.stringify({ activeProjectId: projectId }, null, 2));
    } catch (error) {
      return err(error instanceof Error ? error.message : 'Could not set active project');
    }
  }

  if (name === 'list_pending_proposals') {
    try {
      const pending = await mcpSessionService.getPendingProposals(ctx.userId, ctx.sessionId);
      return ok(JSON.stringify({ proposals: pending }, null, 2));
    } catch (error) {
      return err(error instanceof Error ? error.message : 'Could not list proposals');
    }
  }

  if (name === 'approve_proposal') {
    const proposalId = String(input.proposalId ?? '');
    if (!proposalId) return err('proposalId is required');
    try {
      const text = await mcpSessionService.approveProposal(ctx.userId, ctx.sessionId, proposalId);
      return ok(text);
    } catch (error) {
      return err(error instanceof Error ? error.message : 'Could not approve proposal');
    }
  }

  if (name === 'reject_proposal') {
    const proposalId = String(input.proposalId ?? '');
    if (!proposalId) return err('proposalId is required');
    try {
      const text = await mcpSessionService.rejectProposal(ctx.userId, ctx.sessionId, proposalId);
      return ok(text);
    } catch (error) {
      return err(error instanceof Error ? error.message : 'Could not reject proposal');
    }
  }

  if (MCP_WRITE_TOOLS.has(name)) {
    try {
      const { text } = await mcpSessionService.stageWriteTool(
        ctx.userId,
        ctx.sessionId,
        name,
        input
      );
      return ok(text);
    } catch (error) {
      return err(error instanceof Error ? error.message : 'Could not stage write');
    }
  }

  if (MCP_READ_TOOLS.has(name)) {
    const args = { ...input };
    if (
      ctx.activeProjectId &&
      name === 'find_tasks' &&
      args.projectId == null &&
      args.query == null
    ) {
      args.projectId = ctx.activeProjectId;
    }
    return executeTool(name, args, ctx.userId, { source: 'agent' });
  }

  return err(`Unknown tool: ${name}`);
}

export const mcpInternalToolDefinitions = [
  {
    name: 'set_active_project',
    description: 'Set the active project for this MCP session (scopes implicit project queries).',
    zodShape: {
      projectId: z.string().regex(/^[0-9a-f]{24}$/i, 'Must be a real 24-character hex project id'),
    },
  },
  {
    name: 'list_pending_proposals',
    description: 'List staged write proposals awaiting user confirmation in the LLM chat.',
    zodShape: {},
  },
  {
    name: 'approve_proposal',
    description: 'Commit a staged proposal after the user confirms in chat.',
    zodShape: {
      proposalId: z.string().min(1),
    },
  },
  {
    name: 'reject_proposal',
    description: 'Discard a staged proposal after the user declines in chat.',
    zodShape: {
      proposalId: z.string().min(1),
    },
  },
] as const;

export function isMcpRegisteredTool(name: string): boolean {
  return (
    MCP_READ_TOOLS.has(name) ||
    MCP_WRITE_TOOLS.has(name) ||
    MCP_INTERNAL_TOOLS.has(name)
  );
}
