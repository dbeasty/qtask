import { executeTool } from '../agent/tools.js';
import type { AgentStreamEvent, StoredMessage } from '../types/conversation.js';
import { entityLinksFromToolResult } from './toolEntityLinks.js';

function toolResultEvent(
  name: string,
  success: boolean,
  content: string,
  scopeProjectId?: string
) {
  const entityLinks = entityLinksFromToolResult(name, content, success, scopeProjectId);
  return {
    type: 'tool_result' as const,
    name,
    success,
    content,
    ...(entityLinks !== undefined ? { entityLinks } : {}),
  };
}

export const LIST_PROJECT_TASKS_PREFLIGHT_NUDGE =
  'find_tasks already ran for the active project. The UI shows clickable task rows. Reply with one short sentence only (e.g. count or highlight). Do not call get_task, summarize_project, get_project, or update_project again for this listing request. Do not repeat task titles or numbered lists.';

export async function* runListProjectTasksPreflight(
  userId: string,
  projectId: string,
  workingMessages: StoredMessage[]
): AsyncGenerator<AgentStreamEvent, void> {
  const name = 'find_tasks';
  const args = { projectId, limit: 100 };

  yield { type: 'tool_call', name, arguments: args };

  const result = await executeTool(name, args, userId);
  yield toolResultEvent(name, result.success, result.text, projectId);

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
    content: LIST_PROJECT_TASKS_PREFLIGHT_NUDGE,
  });
}
