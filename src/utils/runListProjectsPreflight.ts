import { executeTool } from '../agent/tools.js';
import type { AgentStreamEvent, StoredMessage } from '../types/conversation.js';
import { entityLinksFromToolResult } from './toolEntityLinks.js';

function toolResultEvent(name: string, success: boolean, content: string) {
  const entityLinks = entityLinksFromToolResult(name, content, success);
  return {
    type: 'tool_result' as const,
    name,
    success,
    content,
    ...(entityLinks !== undefined ? { entityLinks } : {}),
  };
}

export const LIST_PROJECTS_PREFLIGHT_NUDGE =
  'list_projects already ran for this request. The UI shows clickable project rows. Reply with one short sentence only (e.g. count or highlight). Do not repeat project names, IDs, or numbered lists.';

export async function* runListProjectsPreflight(
  userId: string,
  workingMessages: StoredMessage[]
): AsyncGenerator<AgentStreamEvent, void> {
  const name = 'list_projects';
  const args = {};

  yield { type: 'tool_call', name, arguments: args };

  const result = await executeTool(name, args, userId, { source: 'agent' });
  yield toolResultEvent(name, result.success, result.text);

  workingMessages.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ function: { name, arguments: args } }],
  });
  workingMessages.push({
    role: 'tool',
    content: result.text,
    toolName: name,
  });
  workingMessages.push({
    role: 'system',
    content: LIST_PROJECTS_PREFLIGHT_NUDGE,
  });
}
