import type { PendingProposal, StoredMessage, UiMessage, UiToolCall, UiToolCallEnrichment } from '../types';

export function mergeToolCalls(
  toolCalls: StoredMessage['toolCalls'],
  enrichments?: UiToolCallEnrichment[]
): UiToolCall[] | undefined {
  if (!toolCalls?.length) return undefined;

  return toolCalls.map((call, index) => {
    const enriched = enrichments?.[index];
    return {
      name: call.function.name,
      arguments: call.function.arguments,
      success: enriched?.success,
      errorContent: enriched?.errorContent,
      entityLinks: enriched?.entityLinks,
    };
  });
}

export function mergeAssistantTurns(messages: UiMessage[]): UiMessage[] {
  const result: UiMessage[] = [];
  let pendingAssistants: UiMessage[] = [];

  function flushAssistants() {
    if (pendingAssistants.length === 0) return;
    if (pendingAssistants.length === 1) {
      result.push(pendingAssistants[0]!);
    } else {
      result.push(mergeAssistantGroup(pendingAssistants));
    }
    pendingAssistants = [];
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flushAssistants();
      result.push(message);
      continue;
    }

    if (message.role === 'assistant') {
      pendingAssistants.push(message);
    }
  }

  flushAssistants();
  return result;
}

function mergeAssistantGroup(group: UiMessage[]): UiMessage {
  const first = group[0]!;
  const last = group[group.length - 1]!;

  const toolCalls: UiToolCall[] = [];
  const proposals: UiMessage['proposals'] = [];
  const warnings: string[] = [];
  let paused = false;

  for (const message of group) {
    if (message.toolCalls?.length) toolCalls.push(...message.toolCalls);
    if (message.proposals?.length) proposals.push(...message.proposals);
    if (message.warnings?.length) warnings.push(...message.warnings);
    if (message.paused) paused = true;
  }

  const statusMessage = [...group].reverse().find((message) => message.statusMessage)?.statusMessage;

  return {
    id: first.id,
    role: 'assistant',
    content: last.content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    proposals: proposals.length > 0 ? proposals : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    paused: paused || undefined,
    streaming: group.some((message) => message.streaming) || undefined,
    statusMessage,
  };
}

export function buildUiMessagesFromConversation(
  conversationId: string,
  visibleStored: StoredMessage[],
  messageProposals: Record<number, PendingProposal[]>,
  messageToolResults: Record<number, UiToolCallEnrichment[]>
): UiMessage[] {
  const raw: UiMessage[] = visibleStored.map((message, index) => {
    const proposals = messageProposals[index];
    const hasPending = proposals?.some((proposal) => proposal.status === 'pending');

    return {
      id: `${conversationId}-${index}`,
      role: message.role as 'user' | 'assistant',
      content: message.content,
      toolCalls: mergeToolCalls(message.toolCalls, messageToolResults[index]),
      proposals: proposals?.length ? proposals : undefined,
      paused: Boolean(hasPending),
    };
  });

  return mergeAssistantTurns(raw);
}
