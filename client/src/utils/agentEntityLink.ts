import type { TaskStatus, UiProposal } from '../types';

export interface AgentEntityLink {
  kind: 'task' | 'project';
  id: string;
  label: string;
  status?: TaskStatus;
  percentComplete?: number;
  projectId?: string;
}

const TASK_STATUS_VALUES: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
const TASK_LIST_TOOLS = new Set(['find_tasks', 'get_workload']);
const PROJECT_HIGHLIGHT_TOOLS = new Set(['get_project', 'summarize_project']);

function filterTaskLinksByProject(links: AgentEntityLink[], projectId: string | undefined): AgentEntityLink[] {
  if (!projectId) return links;
  return links.filter((link) => link.kind !== 'task' || link.projectId === projectId);
}

function updateHighlightedProjectId(
  current: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
  success: boolean,
  entityLinks?: AgentEntityLink[]
): string | undefined {
  if (!success) return current;

  const projectIdArg = stringArg(args, 'projectId');
  if (projectIdArg && TASK_LIST_TOOLS.has(toolName)) {
    return projectIdArg;
  }

  if (PROJECT_HIGHLIGHT_TOOLS.has(toolName)) {
    if (projectIdArg) return projectIdArg;
    const projectLink = entityLinks?.find((link) => link.kind === 'project');
    if (projectLink) return projectLink.id;
  }

  return current;
}

export function filterToolCallsEntityLinks(toolCalls: Array<{
  name: string;
  arguments?: Record<string, unknown>;
  success?: boolean;
  entityLinks?: AgentEntityLink[];
}>): Array<{
  name: string;
  arguments?: Record<string, unknown>;
  success?: boolean;
  entityLinks?: AgentEntityLink[];
}> {
  let highlightedProjectId: string | undefined;

  return toolCalls.map((call) => {
    const scope = highlightedProjectId;
    let entityLinks = call.entityLinks;
    if (entityLinks && scope && TASK_LIST_TOOLS.has(call.name)) {
      entityLinks = filterTaskLinksByProject(entityLinks, scope);
    }

    const success = call.success !== false;
    highlightedProjectId = updateHighlightedProjectId(
      highlightedProjectId,
      call.name,
      call.arguments ?? {},
      success,
      entityLinks
    );

    return entityLinks !== call.entityLinks ? { ...call, entityLinks } : call;
  });
}

function unwrapTaskTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const inner = JSON.parse(trimmed) as {
      title?: string;
      parameters?: { title?: string };
    };
    if (typeof inner.parameters?.title === 'string') return inner.parameters.title;
    if (typeof inner.title === 'string') return inner.title;
  } catch {
    // keep original
  }
  return trimmed;
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function taskStatusArg(args: Record<string, unknown>): TaskStatus | undefined {
  const value = args.status;
  if (typeof value === 'string' && TASK_STATUS_VALUES.includes(value as TaskStatus)) {
    return value as TaskStatus;
  }
  return undefined;
}

function percentCompleteArg(args: Record<string, unknown>): number | undefined {
  const value = args.percentComplete;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, value));
  }
  return undefined;
}

function proposalLabel(proposal: UiProposal): string {
  const title = stringArg(proposal.arguments, 'title');
  if (title) return unwrapTaskTitle(title);
  const name = stringArg(proposal.arguments, 'name');
  if (name) return name;
  return proposal.name.replace(/_/g, ' ');
}

function taskBelongsToActiveProject(
  args: Record<string, unknown>,
  activeProjectId: string | null
): boolean {
  if (!activeProjectId) return false;
  const projectId = stringArg(args, 'projectId');
  if (!projectId) return true;
  return projectId === activeProjectId;
}

function resolveCreateEntityLink(
  proposal: UiProposal,
  activeProjectId: string | null
): AgentEntityLink | null {
  if (proposal.status !== 'approved' || !proposal.stagedEntity) return null;

  const { kind, id } = proposal.stagedEntity;
  if (kind === 'task') {
    if (!taskBelongsToActiveProject(proposal.arguments, activeProjectId)) return null;
    return {
      kind: 'task',
      id,
      label: proposalLabel(proposal),
      status: taskStatusArg(proposal.arguments) ?? 'todo',
      percentComplete: percentCompleteArg(proposal.arguments) ?? 0,
    };
  }

  if (kind === 'project') {
    return {
      kind: 'project',
      id,
      label: proposalLabel(proposal),
    };
  }

  return null;
}

function resolveUpdateTaskLink(
  proposal: UiProposal,
  activeProjectId: string | null
): AgentEntityLink | null {
  if (proposal.status !== 'approved') return null;
  const taskId = stringArg(proposal.arguments, 'taskId');
  if (!taskId) return null;
  if (!taskBelongsToActiveProject(proposal.arguments, activeProjectId)) return null;

  return {
    kind: 'task',
    id: taskId,
    label: proposalLabel(proposal),
    status: taskStatusArg(proposal.arguments),
    percentComplete: percentCompleteArg(proposal.arguments),
  };
}

function resolveUpdateProjectLink(
  proposal: UiProposal,
  activeProjectId: string | null
): AgentEntityLink | null {
  if (proposal.status !== 'approved') return null;
  const projectId = stringArg(proposal.arguments, 'projectId');
  if (!projectId || !activeProjectId || projectId !== activeProjectId) return null;

  return {
    kind: 'project',
    id: projectId,
    label: proposalLabel(proposal),
  };
}

export function getProposalEntityLink(
  proposal: UiProposal,
  activeProjectId: string | null
): AgentEntityLink | null {
  switch (proposal.name) {
    case 'create_task':
    case 'create_project':
      return resolveCreateEntityLink(proposal, activeProjectId);
    case 'update_task':
      return resolveUpdateTaskLink(proposal, activeProjectId);
    case 'update_project':
      return resolveUpdateProjectLink(proposal, activeProjectId);
    default:
      return null;
  }
}
