import { validateToolProposal } from '../agent/tools.js';
import {
  stagedToolContent,
  stageCreateTool,
} from '../agent/stageCreateProposal.js';
import type { AgentStreamEvent, PendingProposal, StoredMessage } from '../types/conversation.js';
import { conversationService } from '../services/conversationService.js';
import { projectService } from '../services/projectService.js';
import type { ProjectCreateScope } from './createProjectQuery.js';
import { filterSimilarProjects } from './filterSimilarProjects.js';
import { slimProjectForTool } from './serialization.js';
import { entityLinksFromToolResult } from './toolEntityLinks.js';

export { filterSimilarProjects } from './filterSimilarProjects.js';

export interface CreateProjectPreflightResult {
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

export function createProjectSimilarNudge(name: string): string {
  return (
    `Similar projects in this scope may appear above. ` +
    `A new project "${name}" is staged for approval — use Approve/Reject in the UI.`
  );
}

export function createProjectDuplicateNudge(name: string): string {
  return (
    `A project named "${name}" already exists in this scope (see list_projects above; UI shows a clickable link). ` +
    'Tell the user briefly. Do not call create_project unless they explicitly confirm they want a duplicate.'
  );
}

export function createProjectDuplicateAssistantMessage(name: string): string {
  return `A project named "${name}" already exists in this scope — open it using the link above.`;
}

async function findExactNameDuplicate(
  userId: string,
  name: string,
  scope: ProjectCreateScope
): Promise<Record<string, unknown> | null> {
  const normalized = name.trim().toLowerCase();
  const projects = await projectService.listProjects(userId);
  const match = projects.find((project) => {
    const parentId = project.parentId ?? null;
    const inScope = scope.parentId === null ? parentId === null : parentId === scope.parentId;
    return inScope && String(project.name ?? '').trim().toLowerCase() === normalized;
  });
  return (match as Record<string, unknown> | undefined) ?? null;
}

function projectsListResult(projects: Record<string, unknown>[]): string {
  const slim = projects.map((project) => slimProjectForTool(project));
  return JSON.stringify({ count: slim.length, projects: slim }, null, 2);
}

async function* emitListProjectsResult(
  listArgs: Record<string, unknown>,
  listResultText: string,
  activeProjectId: string | undefined,
  workingMessages: StoredMessage[]
): AsyncGenerator<AgentStreamEvent> {
  const listName = 'list_projects';
  yield { type: 'tool_call', name: listName, arguments: listArgs };
  yield toolResultEvent(listName, true, listResultText, activeProjectId);
  workingMessages.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ function: { name: listName, arguments: listArgs } }],
  });
  workingMessages.push({
    role: 'tool',
    content: listResultText,
    toolName: listName,
  });
}

export async function* runCreateProjectPreflight(
  userId: string,
  conversationId: string,
  activeProjectId: string | undefined,
  name: string,
  scope: ProjectCreateScope,
  workingMessages: StoredMessage[]
): AsyncGenerator<AgentStreamEvent, CreateProjectPreflightResult> {
  const duplicate = await findExactNameDuplicate(userId, name, scope);

  if (duplicate) {
    const listArgs = {};
    const listResultText = projectsListResult([duplicate]);
    yield* emitListProjectsResult(listArgs, listResultText, activeProjectId, workingMessages);
    workingMessages.push({
      role: 'system',
      content: createProjectDuplicateNudge(name),
    });
    workingMessages.push({
      role: 'assistant',
      content: createProjectDuplicateAssistantMessage(name),
    });
    await conversationService.savePauseState(userId, conversationId, {
      messages: workingMessages,
      pendingProposals: (await conversationService.getConversation(userId, conversationId))
        ?.pendingProposals ?? [],
      pausedBatch: null,
    });
    return { staged: false, pauseImmediately: true, duplicate: true, pendingCount: 0 };
  }

  const createArgs: Record<string, unknown> = { name };
  if (scope.parentId) {
    createArgs.parentId = scope.parentId;
  }

  const validation = validateToolProposal('create_project', createArgs);
  if (!validation.success) {
    workingMessages.push({
      role: 'system',
      content: `create_project preflight failed: ${validation.error}. Invoke create_project via the tool API with corrected arguments.`,
    });
    await conversationService.savePauseState(userId, conversationId, {
      messages: workingMessages,
      pendingProposals: (await conversationService.getConversation(userId, conversationId))
        ?.pendingProposals ?? [],
      pausedBatch: null,
    });
    return { staged: false, pauseImmediately: false, pendingCount: 0 };
  }

  const createName = 'create_project';
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

  const allProjects = await projectService.listProjects(userId);
  const similar = filterSimilarProjects(
    allProjects as unknown as Record<string, unknown>[],
    name,
    scope
  ).slice(0, 5);
  if (similar.length > 0) {
    const listResultText = projectsListResult(similar);
    yield* emitListProjectsResult({}, listResultText, activeProjectId, workingMessages);
    workingMessages.push({
      role: 'system',
      content: createProjectSimilarNudge(name),
    });
  }

  workingMessages.push({
    role: 'assistant',
    content: `Staged project "${name}" for your approval.`,
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
