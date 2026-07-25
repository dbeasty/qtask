import type { PendingProposal, StoredMessage } from '../types/conversation.js';
import { slimProjectForTool, slimTaskForTool } from './serialization.js';

export function isStagedPendingToolContent(content: string): boolean {
  return content.includes('STAGED:');
}

export async function buildCommittedCreateEntityLinkSource(
  userId: string,
  proposal: PendingProposal
): Promise<string | undefined> {
  const entity = proposal.stagedEntity;
  if (!entity) return undefined;

  if (entity.kind === 'project') {
    const { projectService } = await import('../services/projectService.js');
    const project = await projectService.getProject(userId, entity.id);
    if (!project) return undefined;
    return JSON.stringify(
      slimProjectForTool(project as unknown as Record<string, unknown>),
      null,
      2
    );
  }

  if (entity.kind === 'task') {
    const { taskService } = await import('../services/taskService.js');
    const task = await taskService.getTask(userId, entity.id);
    if (!task) return undefined;
    return JSON.stringify(slimTaskForTool(task as Record<string, unknown>), null, 2);
  }

  return undefined;
}

export function patchMessagesAfterStagedCreateCommit(
  messages: StoredMessage[],
  proposal: PendingProposal,
  entityLinkSource: string
): StoredMessage[] {
  const entityId = proposal.stagedEntity?.id;
  if (!entityId) return messages;

  return messages.map((message) => {
    if (
      message.role === 'tool' &&
      message.toolName === proposal.name &&
      message.content.includes(entityId) &&
      isStagedPendingToolContent(message.content)
    ) {
      return {
        ...message,
        content: entityLinkSource,
        entityLinkSource,
      };
    }
    return message;
  });
}

export function clearStagedCreateAssistantSummaries(messages: StoredMessage[]): StoredMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    const trimmed = message.content.trim();
    if (/^Staged (?:project|task) "/.test(trimmed)) {
      return { ...message, content: '' };
    }
    return message;
  });
}
