import { executeTool, validateToolProposal } from '../agent/tools.js';
import {
  stagedToolContent,
  stageCreateTool,
} from '../agent/stageCreateProposal.js';
import type { AgentStreamEvent, PendingProposal, StoredMessage } from '../types/conversation.js';
import { conversationService } from '../services/conversationService.js';
import { taskService } from '../services/taskService.js';
import { slimTaskForTool } from './serialization.js';
import { entityLinksFromToolResult } from './toolEntityLinks.js';

export interface CreateTaskPreflightResult {
  staged: boolean;
  pauseImmediately: boolean;
  duplicate?: boolean;
  pendingCount: number;
}

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

export function createTaskSimilarNudge(title: string): string {
  return (
    `Similar tasks in the active project may appear above. ` +
    `A new task "${title}" is staged for approval — use Approve/Reject in the UI.`
  );
}

export function createTaskDuplicateNudge(title: string): string {
  return (
    `A task titled "${title}" already exists in the active project (see find_tasks above; UI shows a clickable link). ` +
    'Tell the user briefly. Do not call create_task unless they explicitly confirm they want a duplicate.'
  );
}

export function createTaskDuplicateAssistantMessage(title: string): string {
  return `A task titled "${title}" already exists in this project — open it using the link above.`;
}

async function findExactTitleDuplicate(
  userId: string,
  title: string,
  projectId: string
): Promise<Record<string, unknown> | null> {
  const normalized = title.trim().toLowerCase();
  const tasks = await taskService.listTasks(userId, { projectId });
  const match = tasks.find(
    (task) => String(task.title ?? '').trim().toLowerCase() === normalized
  );
  return match ?? null;
}

function tasksFindResult(tasks: Record<string, unknown>[]): string {
  const slim = tasks.map((task) => slimTaskForTool(task));
  return JSON.stringify({ count: slim.length, tasks: slim }, null, 2);
}

function filterSimilarTasks(
  resultText: string,
  title: string,
  projectId: string
): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(resultText) as { tasks?: Array<Record<string, unknown>> };
    if (!Array.isArray(parsed.tasks)) return [];
    const normalized = title.trim().toLowerCase();
    return parsed.tasks.filter((task) => {
      const taskTitle = typeof task.title === 'string' ? task.title.trim().toLowerCase() : '';
      if (!taskTitle || taskTitle === normalized) return false;
      const projectIds = Array.isArray(task.projectIds)
        ? task.projectIds.map(String)
        : [];
      const primary = task.projectId ? String(task.projectId) : projectIds[0];
      return primary === projectId || projectIds.includes(projectId);
    });
  } catch {
    return [];
  }
}

async function* emitFindTasksResult(
  findArgs: Record<string, unknown>,
  findResultText: string,
  findSuccess: boolean,
  activeProjectId: string,
  workingMessages: StoredMessage[]
): AsyncGenerator<AgentStreamEvent> {
  const findName = 'find_tasks';
  yield { type: 'tool_call', name: findName, arguments: findArgs };
  yield toolResultEvent(findName, findSuccess, findResultText, activeProjectId);
  workingMessages.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ function: { name: findName, arguments: findArgs } }],
  });
  workingMessages.push({
    role: 'tool',
    content: findResultText,
    toolName: findName,
  });
}

export async function* runCreateTaskPreflight(
  userId: string,
  conversationId: string,
  activeProjectId: string,
  title: string,
  workingMessages: StoredMessage[]
): AsyncGenerator<AgentStreamEvent, CreateTaskPreflightResult> {
  const duplicate = await findExactTitleDuplicate(userId, title, activeProjectId);

  if (duplicate) {
    const findArgs: Record<string, unknown> = {
      query: title,
      limit: 1,
      projectId: activeProjectId,
    };
    const findResultText = tasksFindResult([duplicate]);
    yield* emitFindTasksResult(findArgs, findResultText, true, activeProjectId, workingMessages);
    workingMessages.push({
      role: 'system',
      content: createTaskDuplicateNudge(title),
    });
    workingMessages.push({
      role: 'assistant',
      content: createTaskDuplicateAssistantMessage(title),
    });
    await conversationService.savePauseState(userId, conversationId, {
      messages: workingMessages,
      pendingProposals: (await conversationService.getConversation(userId, conversationId))
        ?.pendingProposals ?? [],
      pausedBatch: null,
    });
    return { staged: false, pauseImmediately: true, duplicate: true, pendingCount: 0 };
  }

  const createArgs: Record<string, unknown> = { title, projectId: activeProjectId };
  const validation = validateToolProposal('create_task', createArgs);
  if (!validation.success) {
    workingMessages.push({
      role: 'system',
      content: `create_task preflight failed: ${validation.error}. Invoke create_task via the tool API with corrected arguments.`,
    });
    await conversationService.savePauseState(userId, conversationId, {
      messages: workingMessages,
      pendingProposals: (await conversationService.getConversation(userId, conversationId))
        ?.pendingProposals ?? [],
      pausedBatch: null,
    });
    return { staged: false, pauseImmediately: false, pendingCount: 0 };
  }

  const createName = 'create_task';
  const current = await conversationService.getConversation(userId, conversationId);
  const proposals: PendingProposal[] = [...(current?.pendingProposals ?? [])];

  yield { type: 'tool_call', name: createName, arguments: validation.data };
  const staged = await stageCreateTool(
    userId,
    conversationId,
    createName,
    validation.data,
    'native',
    proposals,
    0
  );

  yield toolResultEvent(
    createName,
    staged.result.success,
    staged.result.success ? stagedToolContent(staged.result.text) : staged.result.text,
    activeProjectId
  );

  workingMessages.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ function: { name: createName, arguments: validation.data } }],
  });
  workingMessages.push({
    role: 'tool',
    content: staged.result.success
      ? stagedToolContent(staged.result.text)
      : staged.result.text,
    toolName: createName,
  });

  let pendingCount = 0;
  if (staged.proposal && staged.isNew) {
    proposals.push(staged.proposal);
    pendingCount = 1;
    yield {
      type: 'tool_proposal',
      id: staged.proposal.id,
      name: staged.proposal.name,
      arguments: staged.proposal.arguments,
      source: staged.proposal.source,
      staged: true,
      stagedEntity: staged.proposal.stagedEntity,
    };
  }

  const findArgs: Record<string, unknown> = {
    query: title,
    limit: 5,
    projectId: activeProjectId,
  };
  const findResult = await executeTool('find_tasks', findArgs, userId);
  const similar = filterSimilarTasks(findResult.text, title, activeProjectId);
  if (similar.length > 0) {
    const similarResultText = tasksFindResult(similar);
    yield* emitFindTasksResult(findArgs, similarResultText, true, activeProjectId, workingMessages);
    workingMessages.push({
      role: 'system',
      content: createTaskSimilarNudge(title),
    });
  }

  workingMessages.push({
    role: 'assistant',
    content: `Staged task "${title}" for your approval.`,
  });

  await conversationService.savePauseState(userId, conversationId, {
    messages: workingMessages,
    pendingProposals: proposals,
    pausedBatch: null,
  });

  return {
    staged: Boolean(staged.proposal && staged.result.success),
    pauseImmediately: Boolean(staged.proposal && staged.result.success),
    pendingCount,
  };
}
