export const MCP_READ_TOOLS = new Set([
  'find_tasks',
  'get_task',
  'get_workload',
  'get_project',
  'summarize_project',
  'list_projects',
  'get_project_tracking',
]);

export const MCP_WRITE_TOOLS = new Set([
  'create_task',
  'update_task',
  'update_project',
  'create_project',
  'assign_task',
  'share_project',
  'share_task',
  'add_task_link',
  'add_comment',
]);

export const MCP_SESSION_TOOLS = new Set([
  'set_active_project',
  'list_pending_proposals',
  'approve_proposal',
  'reject_proposal',
]);

export const MCP_INTERNAL_TOOLS = new Set([...MCP_SESSION_TOOLS]);

export function isReadOnlyMode(): boolean {
  return process.env.READ_ONLY_MODE === 'true';
}
