import { randomUUID } from 'node:crypto';
import { sameStagedCreateIntent } from './parseTextToolCall.js';
import { executeTool, normalizeToolArgs } from './tools.js';
import type { PendingProposal } from '../types/conversation.js';

export function createProposal(
  name: string,
  args: Record<string, unknown>,
  source: PendingProposal['source'],
  toolCallIndex?: number
): PendingProposal {
  return {
    id: randomUUID(),
    name,
    arguments: normalizeToolArgs(name, args),
    source,
    status: 'pending',
    toolCallIndex,
  };
}

export function stagedToolContent(resultText: string): string {
  return `${resultText}\n\nSTAGED: This entity exists with a real id but is hidden pending user approval. You may use this id in subsequent tool calls.`;
}

export function stagedEntityId(resultText: string): string | null {
  try {
    const parsed = JSON.parse(resultText) as { _id?: unknown };
    return typeof parsed._id === 'string' ? parsed._id : null;
  } catch {
    return null;
  }
}

function sameProposalArguments(
  proposal: PendingProposal,
  name: string,
  args: Record<string, unknown>
): boolean {
  if (proposal.status !== 'pending' || proposal.name !== name) return false;
  if (name === 'create_task' || name === 'create_project') {
    return sameStagedCreateIntent(proposal, name, args);
  }
  return JSON.stringify(proposal.arguments) === JSON.stringify(args);
}

export function hasDuplicateStagedCreate(
  proposals: PendingProposal[],
  name: string,
  args: Record<string, unknown>
): boolean {
  return proposals.some(
    (proposal) => proposal.stagedEntity && sameStagedCreateIntent(proposal, name, args)
  );
}

export async function stageCreateTool(
  userId: string,
  conversationId: string,
  name: string,
  args: Record<string, unknown>,
  source: PendingProposal['source'],
  existingProposals: PendingProposal[],
  toolCallIndex?: number
): Promise<{
  proposal: PendingProposal | null;
  result: { success: boolean; text: string };
  isNew: boolean;
}> {
  const duplicate = existingProposals.find((proposal) =>
    sameProposalArguments(proposal, name, args)
  );
  if (duplicate?.stagedEntity) {
    return {
      proposal: duplicate,
      result: {
        success: true,
        text: JSON.stringify({ _id: duplicate.stagedEntity.id, staged: true }, null, 2),
      },
      isNew: false,
    };
  }

  const proposal = createProposal(name, args, source, toolCallIndex);
  const result = await executeTool(name, args, userId, {
    conversationId,
    proposalId: proposal.id,
    staged: true,
  });
  if (!result.success) return { proposal: null, result, isNew: false };

  const id = stagedEntityId(result.text);
  if (!id) {
    return {
      proposal: null,
      result: { success: false, text: 'Staged create returned no entity id' },
      isNew: false,
    };
  }
  proposal.stagedEntity = {
    kind: name === 'create_task' ? 'task' : 'project',
    id,
  };
  return { proposal, result, isNew: true };
}
