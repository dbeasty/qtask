import type { TaskStatus } from '../types/task.js';

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
  success: boolean
): ToolEntityLink[] | undefined {
  if (!success) return undefined;

  const parsed = parseToolResultJson(content);
  if (parsed === null) return undefined;

  switch (toolName) {
    case 'find_tasks': {
      const payload = parsed as { tasks?: unknown };
      return mapTasks(payload.tasks);
    }
    case 'get_workload': {
      const payload = parsed as { workload?: unknown };
      return mapTasks(payload.workload);
    }
    case 'get_task': {
      const link = taskToEntityLink(parsed as Record<string, unknown>);
      return link ? [link] : [];
    }
    case 'list_projects': {
      const payload = parsed as { projects?: unknown };
      return mapProjects(payload.projects);
    }
    case 'get_project':
    case 'summarize_project': {
      const link = projectToEntityLink(parsed as Record<string, unknown>);
      return link ? [link] : [];
    }
    default:
      return undefined;
  }
}

export interface UiToolCallEnrichment {
  name: string;
  success: boolean;
  errorContent?: string;
  entityLinks?: ToolEntityLink[];
}

export function buildMessageToolResults(
  messages: Array<{
    role: string;
    content: string;
    toolCalls?: Array<{ function: { name: string } }>;
    toolName?: string;
    entityLinkSource?: string;
  }>
): Record<number, UiToolCallEnrichment[]> {
  const result: Record<number, UiToolCallEnrichment[]> = {};

  let visibleIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
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

        const toolSuccess = isSuccessfulToolResult(call.function.name, toolMessage.content);
        const entityLinks = entityLinksFromToolResult(
          call.function.name,
          toolMessage.entityLinkSource ?? toolMessage.content,
          toolSuccess
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
