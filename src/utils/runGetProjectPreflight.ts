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

export async function* runGetProjectPreflight(
  userId: string,
  projectId: string,
  workingMessages: StoredMessage[]
): AsyncGenerator<AgentStreamEvent, void> {
  const name = 'get_project';
  const args = { projectId };

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
}
