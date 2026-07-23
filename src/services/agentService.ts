import { randomUUID } from 'node:crypto';
import { loadAgentContext } from '../agent/loadContext.js';
import { contentMentionsToolCall, parseTextToolCalls } from '../agent/parseTextToolCall.js';
import {
  buildFindTasksRecoveryArgs,
  needsUpdateTaskIdRecovery,
  wrapFindTasksRecoveryResult,
} from '../agent/taskIdRecovery.js';
import { isStagedCreateTool, isWriteTool } from '../agent/toolPolicy.js';
import { executeTool, getOllamaTools, normalizeToolArgs, validateToolProposal } from '../agent/tools.js';
import { config } from '../config/index.js';
import type {
  AgentStreamEvent,
  Conversation,
  OllamaToolCall,
  PausedBatchState,
  PendingProposal,
  StoredMessage,
} from '../types/conversation.js';
import { createLogger } from '../utils/logger.js';
import { conversationService } from './conversationService.js';
import { createLlmCallTracker, type OllamaTimingFields } from './llmMetrics.js';
import { stagingService } from './stagingService.js';

const log = createLogger('agentService');
const SYSTEM_PROMPT = loadAgentContext();
const MAX_ITERATIONS = 8;

interface OllamaStreamChunk {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      function?: { name?: string; arguments?: Record<string, unknown> };
    }>;
  };
  done?: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

type OllamaStreamPart =
  | { kind: 'token'; content: string }
  | { kind: 'complete'; content: string; toolCalls: OllamaToolCall[] };

function deriveTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 57)}...`;
}

function toOllamaMessages(messages: StoredMessage[]): OllamaChatMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_name: message.toolName,
      };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls,
      };
    }
    return {
      role: message.role,
      content: message.content,
    };
  });
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  return {};
}

function createProposal(
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

function stagedToolContent(resultText: string): string {
  return `${resultText}\n\nSTAGED: This entity exists with a real id but is hidden pending user approval. You may use this id in subsequent tool calls.`;
}

function stagedEntityId(resultText: string): string | null {
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
  if (name === 'create_project') {
    return proposal.arguments.name === args.name;
  }
  return JSON.stringify(proposal.arguments) === JSON.stringify(args);
}

async function stageCreateTool(
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

async function* runUpdateTaskIdRecovery(
  userId: string,
  messagesForQuery: StoredMessage[],
  updateArgs: Record<string, unknown>
): AsyncGenerator<AgentStreamEvent, StoredMessage> {
  const findArgs = buildFindTasksRecoveryArgs(updateArgs, messagesForQuery);
  log.info('Recovering invalid update_task id via find_tasks', {
    query: findArgs.query,
    taskId: updateArgs.taskId,
  });

  yield { type: 'tool_call', name: 'find_tasks', arguments: findArgs };
  const result = await executeTool('find_tasks', findArgs, userId);
  const content = wrapFindTasksRecoveryResult(result.text);
  yield { type: 'tool_result', name: 'find_tasks', success: result.success, content };

  return {
    role: 'tool',
    content,
    toolName: 'find_tasks',
  };
}

/** Save pause state without dropping previously resolved proposal history. */
async function savePausePreservingResolved(
  userId: string,
  conversationId: string,
  data: {
    messages: StoredMessage[];
    pendingProposals: PendingProposal[];
    pausedBatch?: PausedBatchState | null;
  }
) {
  const current = await conversationService.getConversation(userId, conversationId);
  const incomingIds = new Set(data.pendingProposals.map((p) => p.id));
  const resolved = (current?.pendingProposals ?? []).filter(
    (p) => p.status !== 'pending' && !incomingIds.has(p.id)
  );

  return conversationService.savePauseState(userId, conversationId, {
    messages: data.messages,
    pendingProposals: [...resolved, ...data.pendingProposals],
    pausedBatch: data.pausedBatch ?? null,
  });
}

export async function* streamOllamaAgent(
  messages: OllamaChatMessage[],
  iteration: number,
  userId: string,
  conversationId: string
): AsyncGenerator<OllamaStreamPart> {
  log.debug('Ollama chat request', {
    model: config.ollama.model,
    messageCount: messages.length,
    iteration,
  });

  const tracker = createLlmCallTracker({
    callType: 'agent',
    source: 'agent_loop',
    model: config.ollama.model,
    userId,
    conversationId,
    iteration,
  });
  let response: Response;
  try {
    response = await fetch(`${config.ollama.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.model,
        messages,
        tools: getOllamaTools(),
        stream: true,
        keep_alive: config.ollama.keepAlive,
        options: { temperature: 0.2 },
      }),
    });
  } catch (error) {
    tracker.fail(error);
    throw error;
  }

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Ollama chat failed (${response.status}): ${body}`);
    tracker.fail(error, response.status);
    throw error;
  }

  if (!response.body) {
    const error = new Error('Ollama returned an empty response body');
    tracker.fail(error, response.status);
    throw error;
  }

  let content = '';
  const toolCallsByIndex = new Map<number, OllamaToolCall>();
  const tokenBuffer: string[] = [];

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalTiming: OllamaTimingFields | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as OllamaStreamChunk;
        if (chunk.done) {
          finalTiming = chunk;
        }
        const message = chunk.message;
        if (!message) continue;

        if (message.content) {
          content += message.content;
          tokenBuffer.push(message.content);
        }

        if (message.tool_calls) {
          for (let i = 0; i < message.tool_calls.length; i++) {
            const call = message.tool_calls[i];
            if (!call?.function?.name) continue;

            const existing = toolCallsByIndex.get(i) ?? {
              function: { name: call.function.name, arguments: {} },
            };

            if (call.function.name) {
              existing.function.name = call.function.name;
            }
            if (call.function.arguments) {
              existing.function.arguments = {
                ...existing.function.arguments,
                ...parseToolArguments(call.function.arguments),
              };
            }
            toolCallsByIndex.set(i, existing);
          }
        }
      }
    }
  } catch (error) {
    tracker.fail(error, response.status);
    throw error;
  }
  tracker.complete(response.status, finalTiming);

  const toolCalls = [...toolCallsByIndex.values()];

  log.debug('Ollama chat complete', {
    iteration,
    toolCallCount: toolCalls.length,
    toolNames: toolCalls.map((c) => c.function.name),
    contentLength: content.length,
  });

  if (toolCalls.length === 0) {
    for (const token of tokenBuffer) {
      yield { kind: 'token', content: token };
    }
  }

  yield {
    kind: 'complete',
    content,
    toolCalls,
  };
}

function buildMessageProposals(conversation: Conversation): Record<number, PendingProposal[]> {
  const visibleMessages = conversation.messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant'
  );
  const result: Record<number, PendingProposal[]> = {};
  const assigned = new Set<string>();
  const allProposals = conversation.pendingProposals ?? [];

  visibleMessages.forEach((message, visibleIndex) => {
    if (message.role !== 'assistant') return;

    const proposals: PendingProposal[] = [];

    if (message.toolCalls) {
      message.toolCalls.forEach((call, toolIndex) => {
        if (!isWriteTool(call.function.name)) return;

        const match = allProposals.find(
          (proposal) =>
            !assigned.has(proposal.id) &&
            proposal.name === call.function.name &&
            proposal.toolCallIndex === toolIndex
        );

        if (match) {
          proposals.push(match);
          assigned.add(match.id);
          return;
        }

        const fallbackMatch = allProposals.find(
          (proposal) =>
            !assigned.has(proposal.id) &&
            proposal.name === call.function.name &&
            proposal.toolCallIndex === undefined
        );
        if (fallbackMatch) {
          proposals.push(fallbackMatch);
          assigned.add(fallbackMatch.id);
          return;
        }

        proposals.push({
          id: `hist-${visibleIndex}-${toolIndex}`,
          name: call.function.name,
          arguments: normalizeToolArgs(call.function.name, call.function.arguments ?? {}),
          source: 'native',
          status: 'approved',
          toolCallIndex: toolIndex,
        });
      });
    }

    const textParsed = parseTextToolCalls(message.content).filter((parsed) => isWriteTool(parsed.name));
    const hasNativeWriteTools = message.toolCalls?.some((call) => isWriteTool(call.function.name));

    for (const parsed of textParsed) {
      const match = allProposals.find(
        (proposal) =>
          !assigned.has(proposal.id) &&
          proposal.name === parsed.name &&
          (proposal.source === 'text_fallback' || proposal.source === 'manual')
      );
      if (match) {
        proposals.push(match);
        assigned.add(match.id);
      } else if (!hasNativeWriteTools) {
        proposals.push({
          id: `hist-text-${visibleIndex}-${parsed.name}`,
          name: parsed.name,
          arguments: normalizeToolArgs(parsed.name, parsed.arguments),
          source: 'text_fallback',
          status: 'approved',
        });
      }
    }

    if (proposals.length > 0) {
      result[visibleIndex] = proposals;
    }
  });

  const unassigned = allProposals.filter((proposal) => !assigned.has(proposal.id));
  if (unassigned.length > 0) {
    const lastAssistantIndex = visibleMessages.reduce(
      (acc, message, index) => (message.role === 'assistant' ? index : acc),
      -1
    );
    if (lastAssistantIndex >= 0) {
      result[lastAssistantIndex] = [...(result[lastAssistantIndex] ?? []), ...unassigned];
    }
  }

  return result;
}

export class AgentService {
  private async *runAgentLoop(
    userId: string,
    conversationId: string,
    workingMessages: StoredMessage[],
    startIteration = 0
  ): AsyncGenerator<AgentStreamEvent> {
    let finalAssistantContent = '';

    for (let iteration = startIteration; iteration < MAX_ITERATIONS; iteration++) {
      let content = '';
      let toolCalls: OllamaToolCall[] = [];

      for await (const part of streamOllamaAgent(
        toOllamaMessages(workingMessages),
        iteration,
        userId,
        conversationId
      )) {
        if (part.kind === 'token') {
          yield { type: 'token', content: part.content };
        } else {
          content = part.content;
          toolCalls = part.toolCalls;
        }
      }

      if (toolCalls.length === 0) {
        finalAssistantContent = content;
        workingMessages.push({ role: 'assistant', content });

        const textProposals = parseTextToolCalls(content).filter((p) => isWriteTool(p.name));
        if (textProposals.length > 0) {
          log.info('Text-fallback tool proposals detected', {
            count: textProposals.length,
            names: textProposals.map((p) => p.name),
          });

          const current = await conversationService.getConversation(userId, conversationId);
          const proposals: PendingProposal[] = [...(current?.pendingProposals ?? [])];
          let hadValidationError = false;
          let stagedCreateRan = false;
          let requiresPause = false;

          for (const parsed of textProposals) {
            const validation = validateToolProposal(parsed.name, parsed.arguments);
            if (!validation.success) {
              hadValidationError = true;
              const errorText = `${validation.error}. Fix the arguments and call the tool again.`;
              log.warn('Text-fallback tool proposal validation failed', {
                name: parsed.name,
                error: validation.error,
              });
              yield {
                type: 'tool_result',
                name: parsed.name,
                success: false,
                content: errorText,
              };
              workingMessages.push({
                role: 'tool',
                content: errorText,
                toolName: parsed.name,
              });
              if (needsUpdateTaskIdRecovery(parsed.name, validation.error)) {
                const findMsg = yield* runUpdateTaskIdRecovery(
                  userId,
                  workingMessages,
                  parsed.arguments
                );
                workingMessages.push(findMsg);
              }
              continue;
            }

            if (isStagedCreateTool(parsed.name)) {
              yield { type: 'tool_call', name: parsed.name, arguments: validation.data };
              const staged = await stageCreateTool(
                userId,
                conversationId,
                parsed.name,
                validation.data,
                'text_fallback',
                proposals
              );
              yield {
                type: 'tool_result',
                name: parsed.name,
                success: staged.result.success,
                content: staged.result.text,
              };
              workingMessages.push({
                role: 'tool',
                content: staged.result.success
                  ? stagedToolContent(staged.result.text)
                  : staged.result.text,
                toolName: parsed.name,
              });
              if (staged.proposal && staged.isNew) {
                proposals.push(staged.proposal);
                yield {
                  type: 'tool_proposal',
                  id: staged.proposal.id,
                  name: staged.proposal.name,
                  arguments: staged.proposal.arguments,
                  source: staged.proposal.source,
                  staged: true,
                };
              }
              stagedCreateRan = stagedCreateRan || staged.result.success;
              await savePausePreservingResolved(userId, conversationId, {
                messages: workingMessages,
                pendingProposals: proposals,
                pausedBatch: null,
              });
              continue;
            }

            const proposal = createProposal(parsed.name, validation.data, 'text_fallback');
            proposals.push(proposal);
            requiresPause = true;
            yield {
              type: 'tool_proposal',
              id: proposal.id,
              name: proposal.name,
              arguments: proposal.arguments,
              source: proposal.source,
            };
          }

          if (requiresPause) {
            await savePausePreservingResolved(userId, conversationId, {
              messages: workingMessages,
              pendingProposals: proposals,
              pausedBatch: null,
            });
            yield {
              type: 'paused',
              conversationId,
              pendingCount: proposals.filter((proposal) => proposal.status === 'pending').length,
            };
            yield { type: 'done', conversationId, content: finalAssistantContent, paused: true };
            return;
          }

          if (hadValidationError) {
            continue;
          }
          if (stagedCreateRan) {
            continue;
          }
        }

        if (contentMentionsToolCall(content)) {
          log.warn('Model mentioned tool call but none could be parsed', { contentLength: content.length });
          yield {
            type: 'warning',
            message:
              'The assistant described a tool call in text but it could not be parsed or executed. Try rephrasing your request.',
          };
        }

        const pendingConversation = await conversationService.getConversation(
          userId,
          conversationId
        );
        const pending = (pendingConversation?.pendingProposals ?? []).filter(
          (proposal) => proposal.status === 'pending'
        );
        if (pending.length > 0) {
          await savePausePreservingResolved(userId, conversationId, {
            messages: workingMessages,
            pendingProposals: pendingConversation?.pendingProposals ?? pending,
            pausedBatch: null,
          });
          yield { type: 'paused', conversationId, pendingCount: pending.length };
          yield {
            type: 'done',
            conversationId,
            content: finalAssistantContent,
            paused: true,
          };
          return;
        }

        break;
      }

      workingMessages.push({
        role: 'assistant',
        content: content || '',
        toolCalls,
      });

      const paused = yield* this.processToolCallBatch(
        userId,
        conversationId,
        workingMessages,
        content || '',
        toolCalls,
        0,
        []
      );
      if (paused) {
        yield { type: 'done', conversationId, content: content || '', paused: true };
        return;
      }

      if (iteration === MAX_ITERATIONS - 1) {
        finalAssistantContent =
          'I reached the maximum number of tool calls for this request. Please try a simpler follow-up.';
        yield { type: 'token', content: finalAssistantContent };
        workingMessages.push({ role: 'assistant', content: finalAssistantContent });
      }
    }

    await conversationService.clearPauseState(userId, conversationId, workingMessages);

    yield {
      type: 'done',
      conversationId,
      content: finalAssistantContent,
    };
  }

  private async *processToolCallBatch(
    userId: string,
    conversationId: string,
    workingMessages: StoredMessage[],
    assistantContent: string,
    toolCalls: OllamaToolCall[],
    startIndex: number,
    existingProposals: PendingProposal[] = []
  ): AsyncGenerator<AgentStreamEvent, boolean> {
    const current = await conversationService.getConversation(userId, conversationId);
    const proposals: PendingProposal[] = [
      ...(current?.pendingProposals ?? []),
      ...existingProposals.filter(
        (incoming) => !(current?.pendingProposals ?? []).some((saved) => saved.id === incoming.id)
      ),
    ];

    for (let i = startIndex; i < toolCalls.length; i++) {
      const toolCall = toolCalls[i]!;
      const name = toolCall.function.name;
      const args = normalizeToolArgs(name, toolCall.function.arguments);

      log.info('Processing tool call', { name, write: isWriteTool(name), index: i });

      if (isWriteTool(name)) {
        const validation = validateToolProposal(name, args);
        if (!validation.success) {
          const errorText = `${validation.error}. Fix the arguments and call the tool again.`;
          log.warn('Write tool proposal validation failed', {
            name,
            error: validation.error,
            index: i,
          });
          yield { type: 'tool_call', name, arguments: args };
          yield { type: 'tool_result', name, success: false, content: errorText };
          workingMessages.push({
            role: 'tool',
            content: errorText,
            toolName: name,
          });
          if (needsUpdateTaskIdRecovery(name, validation.error)) {
            const findMsg = yield* runUpdateTaskIdRecovery(userId, workingMessages, args);
            workingMessages.push(findMsg);
          }
          continue;
        }

        if (isStagedCreateTool(name)) {
          yield { type: 'tool_call', name, arguments: validation.data };
          const staged = await stageCreateTool(
            userId,
            conversationId,
            name,
            validation.data,
            'native',
            proposals,
            i
          );
          yield {
            type: 'tool_result',
            name,
            success: staged.result.success,
            content: staged.result.text,
          };
          workingMessages.push({
            role: 'tool',
            content: staged.result.success
              ? stagedToolContent(staged.result.text)
              : staged.result.text,
            toolName: name,
          });

          if (staged.proposal && staged.isNew) {
            proposals.push(staged.proposal);
            yield {
              type: 'tool_proposal',
              id: staged.proposal.id,
              name: staged.proposal.name,
              arguments: staged.proposal.arguments,
              source: staged.proposal.source,
              staged: true,
            };
          }

          await savePausePreservingResolved(userId, conversationId, {
            messages: workingMessages,
            pendingProposals: proposals,
            pausedBatch: null,
          });
          continue;
        }

        const proposal = createProposal(name, validation.data, 'native', i);
        proposals.push(proposal);
        yield {
          type: 'tool_proposal',
          id: proposal.id,
          name: proposal.name,
          arguments: proposal.arguments,
          source: proposal.source,
        };

        const pausedBatch: PausedBatchState = {
          assistantContent,
          toolCalls,
          nextToolIndex: i,
        };

        await savePausePreservingResolved(userId, conversationId, {
          messages: workingMessages,
          pendingProposals: proposals,
          pausedBatch,
        });
        const pendingCount = proposals.filter((p) => p.status === 'pending').length;
        yield { type: 'paused', conversationId, pendingCount };
        return true;
      }

      yield { type: 'tool_call', name, arguments: args };
      const result = await executeTool(name, args, userId);
      yield { type: 'tool_result', name, success: result.success, content: result.text };

      workingMessages.push({
        role: 'tool',
        content: result.text,
        toolName: name,
      });
    }

    return false;
  }

  async recoverPendingProposals(userId: string, conversationId: string) {
    const conversation = await conversationService.getConversation(userId, conversationId);
    if (!conversation) return null;

    const pending = (conversation.pendingProposals ?? []).filter((p) => p.status === 'pending');
    if ((conversation.pendingProposals ?? []).length > 0 || conversation.pausedBatch) {
      return conversation;
    }

    const lastAssistant = [...conversation.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant?.content) {
      return conversation;
    }

    const textProposals = parseTextToolCalls(lastAssistant.content).filter((p) => isWriteTool(p.name));
    if (textProposals.length === 0) {
      return conversation;
    }

    log.info('Recovered text-fallback proposals from conversation history', {
      conversationId: conversation._id,
      count: textProposals.length,
      names: textProposals.map((p) => p.name),
    });

    const proposals = textProposals.map((p) => createProposal(p.name, p.arguments, 'text_fallback'));
    return (
      (await conversationService.savePauseState(userId, conversation._id, {
        messages: conversation.messages,
        pendingProposals: proposals,
        pausedBatch: null,
      })) ?? conversation
    );
  }

  async getConversationForUi(userId: string, conversationId: string) {
    const conversation = await this.recoverPendingProposals(userId, conversationId);
    if (!conversation) return null;

    const pendingProposals = (conversation.pendingProposals ?? []).filter((p) => p.status === 'pending');
    const resolvedProposals = (conversation.pendingProposals ?? []).filter((p) => p.status !== 'pending');

    return {
      ...conversation,
      pendingProposals,
      resolvedProposals,
      messageProposals: buildMessageProposals(conversation),
    };
  }

  async submitManualProposal(
    userId: string,
    conversationId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<{ proposal: PendingProposal } | { error: string }> {
    if (!isWriteTool(name)) {
      return { error: `Tool "${name}" is not a write tool` };
    }

    const validation = validateToolProposal(name, args);
    if (!validation.success) {
      return { error: validation.error };
    }

    const conversation = await conversationService.getConversation(userId, conversationId);
    if (!conversation) {
      return { error: 'Conversation not found' };
    }

    const proposal = createProposal(name, validation.data, 'manual');
    const existingProposals = conversation.pendingProposals ?? [];

    const updated = await conversationService.savePauseState(userId, conversationId, {
      messages: conversation.messages,
      pendingProposals: [...existingProposals, proposal],
      pausedBatch: conversation.pausedBatch ?? null,
    });

    if (!updated) {
      return { error: 'Failed to save proposal' };
    }

    log.info('Manual proposal submitted', {
      conversationId,
      proposalId: proposal.id,
      tool: proposal.name,
    });

    return { proposal };
  }

  async *streamAgent(
    userId: string,
    message: string,
    conversationId?: string,
    projectId?: string
  ): AsyncGenerator<AgentStreamEvent> {
    let conversation =
      conversationId != null
        ? await conversationService.getConversation(userId, conversationId)
        : null;

    if (conversationId && !conversation) {
      yield { type: 'error', message: 'Conversation not found' };
      return;
    }

    if (conversation && projectId && conversation.projectId && conversation.projectId !== projectId) {
      yield { type: 'error', message: 'Conversation does not belong to this project' };
      return;
    }

    if (!conversation) {
      if (projectId) {
        const { projectService } = await import('./projectService.js');
        await projectService.assertProjectAccess(userId, projectId, 'viewer');
      }
      conversation = await conversationService.createConversation(
        userId,
        'New conversation',
        projectId
      );
    } else {
      const discarded = await stagingService.rollbackStaleForConversation(
        userId,
        conversation._id
      );
      if (discarded > 0) {
        conversation =
          (await conversationService.getConversation(userId, conversation._id)) ?? conversation;
        conversation.messages.push({
          role: 'system',
          content: `${discarded} unapproved staged item(s) were discarded before this new message.`,
        });
      }
    }

    const workingMessages: StoredMessage[] = [...conversation.messages];
    if (workingMessages.length === 0) {
      workingMessages.push({ role: 'system', content: SYSTEM_PROMPT });
    }

    workingMessages.push({ role: 'user', content: message });

    const isFirstUserMessage = conversation.messages.filter((m) => m.role === 'user').length === 0;
    const title = isFirstUserMessage ? deriveTitle(message) : undefined;

    if (title) {
      await conversationService.setMessages(userId, conversation._id, workingMessages, title);
    } else {
      await conversationService.setMessages(userId, conversation._id, workingMessages);
    }

    log.info('Agent stream started', { userId, conversationId: conversation._id });

    yield* this.runAgentLoop(userId, conversation._id, workingMessages);
  }

  async *resumeAfterApproval(
    userId: string,
    conversationId: string,
    proposalId: string,
    action: 'approve' | 'reject'
  ): AsyncGenerator<AgentStreamEvent> {
    const conversation = await conversationService.getConversation(userId, conversationId);
    if (!conversation) {
      yield { type: 'error', message: 'Conversation not found' };
      return;
    }

    const proposal = conversation.pendingProposals?.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== 'pending') {
      yield { type: 'error', message: 'Proposal not found or already resolved' };
      return;
    }

    log.info('Resolving proposal', { proposalId, action, tool: proposal.name });

    const extraMessages: StoredMessage[] = [];
    let ranIdRecovery = false;

    if (proposal.stagedEntity) {
      yield { type: 'tool_call', name: proposal.name, arguments: proposal.arguments };
      try {
        const content =
          action === 'approve'
            ? await stagingService.commitProposal(userId, conversationId, proposal)
            : await stagingService.rollbackProposal(userId, conversationId, proposal);
        yield {
          type: 'tool_result',
          name: proposal.name,
          success: true,
          content,
        };
        extraMessages.push({
          role: 'tool',
          content:
            action === 'approve'
              ? `${content}. The staged write is now visible.`
              : `${content}. The staged id is now invalid.`,
          toolName: proposal.name,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to resolve staged write';
        yield {
          type: 'tool_result',
          name: proposal.name,
          success: false,
          content: message,
        };
        yield { type: 'error', message };
        return;
      }
    } else if (action === 'approve') {
      const validation = validateToolProposal(proposal.name, proposal.arguments);

      if (!validation.success) {
        const errorText = `${validation.error}. Fix the arguments and call the tool again.`;
        log.warn('Approved proposal failed revalidation', {
          proposalId,
          name: proposal.name,
          error: validation.error,
        });
        yield { type: 'tool_call', name: proposal.name, arguments: proposal.arguments };
        yield { type: 'tool_result', name: proposal.name, success: false, content: errorText };
        extraMessages.push({
          role: 'tool',
          content: errorText,
          toolName: proposal.name,
        });

        if (needsUpdateTaskIdRecovery(proposal.name, validation.error)) {
          const contextMessages = [...conversation.messages, ...extraMessages];
          const findMsg = yield* runUpdateTaskIdRecovery(
            userId,
            contextMessages,
            proposal.arguments
          );
          extraMessages.push(findMsg);
          ranIdRecovery = true;
        }
      } else {
        yield { type: 'tool_call', name: proposal.name, arguments: validation.data };
        const result = await executeTool(proposal.name, validation.data, userId);
        yield {
          type: 'tool_result',
          name: proposal.name,
          success: result.success,
          content: result.text,
        };
        extraMessages.push({
          role: 'tool',
          content: result.text,
          toolName: proposal.name,
        });

        if (!result.success && needsUpdateTaskIdRecovery(proposal.name, result.text)) {
          const contextMessages = [...conversation.messages, ...extraMessages];
          const findMsg = yield* runUpdateTaskIdRecovery(
            userId,
            contextMessages,
            proposal.arguments
          );
          extraMessages.push(findMsg);
          ranIdRecovery = true;
        }
      }
    } else {
      extraMessages.push({
        role: 'tool',
        content: 'User declined this action',
        toolName: proposal.name,
      });
    }

    const updated = await conversationService.updateProposalStatus(
      userId,
      conversationId,
      proposalId,
      action === 'approve' ? 'approved' : 'rejected',
      extraMessages
    );
    if (!updated) {
      yield { type: 'error', message: 'Failed to update proposal' };
      return;
    }

    const workingMessages: StoredMessage[] = [...updated.messages];
    const remainingPending = (updated.pendingProposals ?? []).filter((p) => p.status === 'pending');

    // After id recovery, clear the paused write batch and let the model propose a
    // corrected update_task (new approval card) from the find_tasks results.
    if (ranIdRecovery) {
      await savePausePreservingResolved(userId, conversationId, {
        messages: workingMessages,
        pendingProposals: updated.pendingProposals ?? [],
        pausedBatch: null,
      });
      yield* this.runAgentLoop(userId, conversationId, workingMessages);
      return;
    }

    if (updated.pausedBatch) {
      const { toolCalls, nextToolIndex } = updated.pausedBatch;

      const paused = yield* this.processToolCallBatch(
        userId,
        conversationId,
        workingMessages,
        updated.pausedBatch.assistantContent,
        toolCalls,
        nextToolIndex + 1,
        updated.pendingProposals ?? []
      );
      if (paused) {
        yield { type: 'done', conversationId, content: '', paused: true };
        return;
      }
    } else if (remainingPending.length > 0) {
      await savePausePreservingResolved(userId, conversationId, {
        messages: workingMessages,
        pendingProposals: updated.pendingProposals ?? [],
        pausedBatch: null,
      });
      yield { type: 'paused', conversationId, pendingCount: remainingPending.length };
      yield { type: 'done', conversationId, content: '', paused: true };
      return;
    }

    yield* this.runAgentLoop(userId, conversationId, workingMessages);
  }
}

export const agentService = new AgentService();
