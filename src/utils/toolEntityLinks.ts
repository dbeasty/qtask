import type { TaskStatus } from '../types/task.js';
import { isStagedPendingToolContent } from './stagedCreateCommit.js';

export interface ToolEntityLink {
  kind: 'task' | 'project';
  id: string;
  label: string;
  status?: TaskStatus;
  percentComplete?: number;
  projectId?: string;
}

const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];

function parseTaskStatus(value: unknown): TaskStatus | undefined {
  if (typeof value === 'string' && TASK_STATUSES.includes(value as TaskStatus)) {
    return value as TaskStatus;
  }
  return undefined;
}

function taskProjectId(task: Record<string, unknown>): string | undefined {
  const projectIds = Array.isArray(task.projectIds)
    ? (task.projectIds as unknown[]).map(String).filter(Boolean)
    : [];
  if (projectIds.length > 0) return projectIds[0];
  if (task.projectId) return String(task.projectId);
  return undefined;
}

function taskToEntityLink(task: Record<string, unknown>): ToolEntityLink | null {
  const id = task._id ? String(task._id) : null;
  const title = task.title ? String(task.title).trim() : '';
  if (!id || !title) return null;

  return {
    kind: 'task',
    id,
    label: title,
    status: parseTaskStatus(task.status),
    percentComplete:
      typeof task.percentComplete === 'number' && Number.isFinite(task.percentComplete)
        ? Math.min(100, Math.max(0, task.percentComplete))
        : undefined,
    projectId: taskProjectId(task),
  };
}

function projectToEntityLink(project: Record<string, unknown>): ToolEntityLink | null {
  const id = project._id ? String(project._id) : null;
  const name = project.name ? String(project.name).trim() : '';
  if (!id || !name) return null;

  return {
    kind: 'project',
    id,
    label: name,
    status: parseTaskStatus(project.status),
    percentComplete:
      typeof project.percentComplete === 'number' && Number.isFinite(project.percentComplete)
        ? Math.min(100, Math.max(0, project.percentComplete))
        : undefined,
  };
}

function mapTasks(items: unknown): ToolEntityLink[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => taskToEntityLink(item as Record<string, unknown>))
    .filter((link): link is ToolEntityLink => link !== null);
}

function mapProjects(items: unknown): ToolEntityLink[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => projectToEntityLink(item as Record<string, unknown>))
    .filter((link): link is ToolEntityLink => link !== null);
}

const READ_TOOLS = new Set(['find_tasks', 'get_workload', 'list_projects', 'get_project', 'get_task']);
const TASK_LIST_TOOLS = new Set(['find_tasks', 'get_workload']);
const PROJECT_HIGHLIGHT_TOOLS = new Set(['get_project', 'summarize_project']);

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

export function filterTaskLinksByProject(
  links: ToolEntityLink[],
  projectId: string | undefined
): ToolEntityLink[] {
  if (!projectId) return links;
  return links.filter((link) => link.kind !== 'task' || link.projectId === projectId);
}

export function updateHighlightedProjectId(
  current: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
  success: boolean,
  entityLinks?: ToolEntityLink[]
): string | undefined {
  if (!success) return current;

  const projectIdArg = stringArg(args, 'projectId');
  if (TASK_LIST_TOOLS.has(toolName) && projectIdArg) {
    return projectIdArg;
  }

  if (PROJECT_HIGHLIGHT_TOOLS.has(toolName)) {
    if (projectIdArg) return projectIdArg;
    const projectLink = entityLinks?.find((link) => link.kind === 'project');
    if (projectLink) return projectLink.id;
  }

  return current;
}

function applyScopeToEntityLinks(
  toolName: string,
  links: ToolEntityLink[] | undefined,
  scopeProjectId: string | undefined
): ToolEntityLink[] | undefined {
  if (links === undefined) return undefined;
  if (!scopeProjectId || !TASK_LIST_TOOLS.has(toolName)) return links;
  return filterTaskLinksByProject(links, scopeProjectId);
}

function parseToolResultJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        return JSON.parse(content.slice(jsonStart, jsonEnd + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isSuccessfulToolResult(toolName: string, content: string): boolean {
  if (READ_TOOLS.has(toolName)) {
    return parseToolResultJson(content) !== null;
  }
  return true;
}

export function entityLinksFromToolResult(
  toolName: string,
  content: string,
  success: boolean,
  scopeProjectId?: string
): ToolEntityLink[] | undefined {
  if (!success) return undefined;

  const parsed = parseToolResultJson(content);
  if (parsed === null) return undefined;

  let links: ToolEntityLink[] | undefined;

  switch (toolName) {
    case 'find_tasks': {
      const payload = parsed as { tasks?: unknown };
      links = mapTasks(payload.tasks);
      break;
    }
    case 'get_workload': {
      const payload = parsed as { workload?: unknown };
      links = mapTasks(payload.workload);
      break;
    }
    case 'get_task': {
      const link = taskToEntityLink(parsed as Record<string, unknown>);
      links = link ? [link] : [];
      break;
    }
    case 'list_projects': {
      const payload = parsed as { projects?: unknown };
      links = mapProjects(payload.projects);
      break;
    }
    case 'get_project':
    case 'summarize_project': {
      const link = projectToEntityLink(parsed as Record<string, unknown>);
      links = link ? [link] : [];
      break;
    }
    case 'create_task': {
      if (isStagedPendingToolContent(content)) return undefined;
      const link = taskToEntityLink(parsed as Record<string, unknown>);
      links = link ? [link] : [];
      break;
    }
    case 'create_project': {
      if (isStagedPendingToolContent(content)) return undefined;
      const link = projectToEntityLink(parsed as Record<string, unknown>);
      links = link ? [link] : [];
      break;
    }
    default:
      return undefined;
  }

  return applyScopeToEntityLinks(toolName, links, scopeProjectId);
}

export function entityLinkSourceForStagedCreate(
  name: string,
  args: Record<string, unknown>,
  resultText: string
): string | undefined {
  const parsed = parseToolResultJson(resultText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  if (name === 'create_task') {
    if (taskToEntityLink(record)) return resultText;
    const id = record._id ? String(record._id) : null;
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!id || !title) return undefined;
    return JSON.stringify({
      _id: id,
      title,
      ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}),
      status: typeof args.status === 'string' ? args.status : 'todo',
      percentComplete: typeof args.percentComplete === 'number' ? args.percentComplete : 0,
    });
  }

  if (name === 'create_project') {
    if (projectToEntityLink(record)) return resultText;
    const id = record._id ? String(record._id) : null;
    const projectName = typeof args.name === 'string' ? args.name.trim() : '';
    if (!id || !projectName) return undefined;
    return JSON.stringify({ _id: id, name: projectName });
  }

  return undefined;
}

export function resolveHighlightedProjectFromMessages(
  messages: Array<{
    role: string;
    toolCalls?: Array<{ function: { name: string; arguments?: Record<string, unknown> } }>;
    toolName?: string;
    content?: string;
    entityLinkSource?: string;
  }>
): string | undefined {
  let highlightedProjectId: string | undefined;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === 'user') {
      highlightedProjectId = undefined;
      continue;
    }
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;

    let toolMessageIndex = i + 1;
    for (const call of message.toolCalls) {
      while (toolMessageIndex < messages.length && messages[toolMessageIndex]?.role !== 'tool') {
        toolMessageIndex++;
      }
      const toolMessage = messages[toolMessageIndex];
      if (!toolMessage || toolMessage.role !== 'tool') continue;

      const args = call.function.arguments ?? {};
      const toolContent = toolMessage.content ?? '';
      const toolSuccess = isSuccessfulToolResult(call.function.name, toolContent);
      const entityLinks = entityLinksFromToolResult(
        call.function.name,
        toolMessage.entityLinkSource ?? toolContent,
        toolSuccess,
        highlightedProjectId
      );
      highlightedProjectId = updateHighlightedProjectId(
        highlightedProjectId,
        call.function.name,
        args,
        toolSuccess,
        entityLinks
      );
      toolMessageIndex++;
    }
  }

  return highlightedProjectId;
}

export interface UiToolCallEnrichment {
  name: string;
  success: boolean;
  errorContent?: string;
  entityLinks?: ToolEntityLink[];
}

function entityLinkInputForToolMessage(
  toolName: string,
  toolMessage: { content: string; entityLinkSource?: string }
): string {
  if (
    (toolName === 'create_project' || toolName === 'create_task') &&
    isStagedPendingToolContent(toolMessage.content)
  ) {
    return toolMessage.content;
  }
  return toolMessage.entityLinkSource ?? toolMessage.content;
}

export function buildMessageToolResults(
  messages: Array<{
    role: string;
    content: string;
    toolCalls?: Array<{ function: { name: string; arguments?: Record<string, unknown> } }>;
    toolName?: string;
    entityLinkSource?: string;
  }>
): Record<number, UiToolCallEnrichment[]> {
  const result: Record<number, UiToolCallEnrichment[]> = {};

  let visibleIndex = 0;
  let highlightedProjectId: string | undefined;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === 'user') {
      highlightedProjectId = undefined;
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const enrichments: UiToolCallEnrichment[] = [];
      let toolMessageIndex = i + 1;

      for (const call of message.toolCalls) {
        while (toolMessageIndex < messages.length && messages[toolMessageIndex]?.role !== 'tool') {
          toolMessageIndex++;
        }

        const toolMessage = messages[toolMessageIndex];
        if (!toolMessage || toolMessage.role !== 'tool') {
          enrichments.push({ name: call.function.name, success: false });
          continue;
        }

        const args = call.function.arguments ?? {};
        const toolSuccess = isSuccessfulToolResult(call.function.name, toolMessage.content);
        const entityLinks = entityLinksFromToolResult(
          call.function.name,
          entityLinkInputForToolMessage(call.function.name, toolMessage),
          toolSuccess,
          highlightedProjectId
        );

        highlightedProjectId = updateHighlightedProjectId(
          highlightedProjectId,
          call.function.name,
          args,
          toolSuccess,
          entityLinks
        );

        enrichments.push({
          name: call.function.name,
          success: toolSuccess,
          errorContent: toolSuccess ? undefined : toolMessage.content,
          entityLinks,
        });

        toolMessageIndex++;
      }

      result[visibleIndex] = enrichments;
    }

    visibleIndex++;
  }

  return result;
}
