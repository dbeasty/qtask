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

function resolveProjectId(
  args: Record<string, unknown>,
  activeProjectId: string | null
): string | null {
  return stringArg(args, 'projectId') ?? activeProjectId;
}

function resolveCreateEntityLinks(
  proposal: UiProposal,
  activeProjectId: string | null,
  resolveProjectLabel?: (projectId: string) => string | undefined
): AgentEntityLink[] {
  if (proposal.status !== 'approved' || !proposal.stagedEntity) return [];

  const { kind, id } = proposal.stagedEntity;
  if (kind === 'task') {
    if (!taskBelongsToActiveProject(proposal.arguments, activeProjectId)) return [];

    const projectId = resolveProjectId(proposal.arguments, activeProjectId);
    const links: AgentEntityLink[] = [
      {
        kind: 'task',
        id,
        label: proposalLabel(proposal),
        status: taskStatusArg(proposal.arguments) ?? 'todo',
        percentComplete: percentCompleteArg(proposal.arguments) ?? 0,
        ...(projectId ? { projectId } : {}),
      },
    ];

    if (projectId) {
      links.push({
        kind: 'project',
        id: projectId,
        label: resolveProjectLabel?.(projectId) ?? projectId,
      });
    }

    return links;
  }

  if (kind === 'project') {
    return [
      {
        kind: 'project',
        id,
        label: proposalLabel(proposal),
      },
    ];
  }

  return [];
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

export function getProposalEntityLinks(
  proposal: UiProposal,
  activeProjectId: string | null,
  resolveProjectLabel?: (projectId: string) => string | undefined
): AgentEntityLink[] {
  switch (proposal.name) {
    case 'create_task':
    case 'create_project':
      return resolveCreateEntityLinks(proposal, activeProjectId, resolveProjectLabel);
    case 'update_task': {
      const link = resolveUpdateTaskLink(proposal, activeProjectId);
      return link ? [link] : [];
    }
    case 'update_project': {
      const link = resolveUpdateProjectLink(proposal, activeProjectId);
      return link ? [link] : [];
    }
    default:
      return [];
  }
}

export function getProposalEntityLink(
  proposal: UiProposal,
  activeProjectId: string | null,
  resolveProjectLabel?: (projectId: string) => string | undefined
): AgentEntityLink | null {
  return getProposalEntityLinks(proposal, activeProjectId, resolveProjectLabel)[0] ?? null;
}

function entityLinkKey(link: AgentEntityLink): string {
  return `${link.kind}:${link.id}`;
}

export function aggregateDedupedEntityLinks(
  toolCalls: Array<{ entityLinks?: AgentEntityLink[] }>
): AgentEntityLink[] {
  const seen = new Set<string>();
  const links: AgentEntityLink[] = [];

  for (const call of toolCalls) {
    for (const link of call.entityLinks ?? []) {
      const key = entityLinkKey(link);
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(link);
    }
  }

  return links;
}

export function aggregatedEntityLinkHeading(links: AgentEntityLink[]): string | null {
  if (links.length === 0) return null;

  const tasks = links.filter((link) => link.kind === 'task');
  const projects = links.filter((link) => link.kind === 'project');

  if (tasks.length === 0 && projects.length === 1) return null;
  if (tasks.length === 1 && projects.length === 0) return '1 task found';
  if (tasks.length > 1 && projects.length === 0) return `${tasks.length} tasks found`;
  if (tasks.length === 0 && projects.length > 1) return `${projects.length} projects found`;
  if (tasks.length === 1 && projects.length === 1) return '1 task found';
  if (tasks.length > 0) return `${tasks.length} tasks found`;
  return `${projects.length} projects found`;
}

export interface EntityLinkSection {
  heading: string | null;
  links: AgentEntityLink[];
}

function dedupeEntityLinks(links: AgentEntityLink[]): AgentEntityLink[] {
  const seen = new Set<string>();
  const deduped: AgentEntityLink[] = [];

  for (const link of links) {
    const key = entityLinkKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(link);
  }

  return deduped;
}

function linksForToolNames(
  toolCalls: Array<{ name: string; entityLinks?: AgentEntityLink[] }>,
  names: Set<string>
): AgentEntityLink[] {
  return dedupeEntityLinks(
    toolCalls
      .filter((call) => names.has(call.name))
      .flatMap((call) => call.entityLinks ?? [])
  );
}

function similarTasksHeading(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? 'Similar existing task' : 'Similar existing tasks';
}

function newTasksHeading(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? 'New task' : 'New tasks';
}

function similarProjectsHeading(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? 'Similar existing project' : 'Similar existing projects';
}

function newProjectsHeading(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? 'New project' : 'New projects';
}

export function isCreateTaskPreflightMessage(
  toolCalls: Array<{ name: string; success?: boolean }> | undefined
): boolean {
  if (!toolCalls?.length) return false;
  return (
    toolCalls.some((call) => call.name === 'create_task' && call.success !== false) &&
    toolCalls.some((call) => call.name === 'find_tasks' && call.success !== false)
  );
}

export function isCreateProjectPreflightMessage(
  toolCalls: Array<{ name: string; success?: boolean }> | undefined
): boolean {
  if (!toolCalls?.length) return false;
  return (
    toolCalls.some((call) => call.name === 'create_project' && call.success !== false) &&
    toolCalls.some((call) => call.name === 'list_projects' && call.success !== false)
  );
}

/** Split tool-call entity links into labeled sections for create preflight vs plain listings. */
export function entityLinkSectionsFromToolCalls(
  toolCalls: Array<{ name: string; success?: boolean; entityLinks?: AgentEntityLink[] }>
): EntityLinkSection[] {
  if (isCreateTaskPreflightMessage(toolCalls)) {
    const createLinks = linksForToolNames(toolCalls, new Set(['create_task']));
    const similarLinks = linksForToolNames(toolCalls, new Set(['find_tasks']));
    const sections: EntityLinkSection[] = [];

    if (createLinks.length > 0) {
      sections.push({ heading: newTasksHeading(createLinks.length), links: createLinks });
    }
    if (similarLinks.length > 0) {
      sections.push({ heading: similarTasksHeading(similarLinks.length), links: similarLinks });
    }

    return sections;
  }

  if (isCreateProjectPreflightMessage(toolCalls)) {
    const createLinks = linksForToolNames(toolCalls, new Set(['create_project']));
    const similarLinks = linksForToolNames(toolCalls, new Set(['list_projects']));
    const sections: EntityLinkSection[] = [];

    if (createLinks.length > 0) {
      sections.push({ heading: newProjectsHeading(createLinks.length), links: createLinks });
    }
    if (similarLinks.length > 0) {
      sections.push({
        heading: similarProjectsHeading(similarLinks.length),
        links: similarLinks,
      });
    }

    return sections;
  }

  const links = aggregateDedupedEntityLinks(toolCalls);
  if (links.length === 0) return [];

  return [{ heading: aggregatedEntityLinkHeading(links), links }];
}

/** Heading for grouped entity links, with create-preflight context when similar items were shown. */
export function aggregatedEntityLinkHeadingForMessage(
  links: AgentEntityLink[],
  toolCalls: Array<{ name: string; success?: boolean; entityLinks?: AgentEntityLink[] }> | undefined,
  _proposals: UiProposal[] | undefined
): string | null {
  if (!toolCalls?.length || links.length === 0) {
    return aggregatedEntityLinkHeading(links);
  }

  const sections = entityLinkSectionsFromToolCalls(toolCalls);
  if (sections.length === 1) {
    return sections[0]?.heading ?? aggregatedEntityLinkHeading(links);
  }
  if (sections.length === 0) {
    return aggregatedEntityLinkHeading(links);
  }

  return null;
}

export function visibleProposals(proposals: UiProposal[] | undefined): UiProposal[] {
  return (proposals ?? []).filter((proposal) => proposal.status !== 'approved');
}

export function getApprovedProposalEntityLinks(
  proposals: UiProposal[] | undefined,
  activeProjectId: string | null,
  resolveProjectLabel?: (projectId: string) => string | undefined,
  existingLinks?: AgentEntityLink[]
): AgentEntityLink[] {
  const seen = new Set((existingLinks ?? []).map(entityLinkKey));
  const links: AgentEntityLink[] = [];

  for (const proposal of proposals ?? []) {
    if (proposal.status !== 'approved') continue;
    for (const link of getProposalEntityLinks(proposal, activeProjectId, resolveProjectLabel)) {
      const key = entityLinkKey(link);
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(link);
    }
  }

  return links;
}
