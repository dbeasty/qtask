import { toolDefinitions } from './tools.js';

const WRITE_TOOLS = new Set([
  'create_task',
  'update_task',
  'create_project',
  'update_project',
  'assign_task',
  'share_project',
  'share_task',
  'add_task_link',
]);

const STAGED_CREATE_TOOLS = new Set(['create_task', 'create_project']);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

export function isStagedCreateTool(name: string): boolean {
  return STAGED_CREATE_TOOLS.has(name);
}

// Derived from toolDefinitions rather than hand-maintained, so this list
// can't silently drift out of sync with the tools the agent actually has
// (a stale list here made parseTextToolCall.ts reject valid calls to any
// tool added after the list was last updated).
export const KNOWN_TOOL_NAMES = toolDefinitions.map((tool) => tool.name);
