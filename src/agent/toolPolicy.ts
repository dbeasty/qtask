const WRITE_TOOLS = new Set([
  'create_task',
  'update_task',
  'create_project',
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

export const KNOWN_TOOL_NAMES = [
  'create_task',
  'update_task',
  'find_tasks',
  'get_task',
  'get_workload',
  'assign_task',
  'share_project',
  'share_task',
  'summarize_project',
  'add_task_link',
  'create_project',
  'list_projects',
] as const;
