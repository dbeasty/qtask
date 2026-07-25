export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface StoredMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: OllamaToolCall[];
  toolName?: string;
  /** Slim JSON for UI entity links (e.g. summarize_project); not sent to the LLM. */
  entityLinkSource?: string;
}

export interface PendingProposal {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  source: 'native' | 'text_fallback' | 'manual';
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  toolCallIndex?: number;
  stagedEntity?: {
    kind: 'task' | 'project';
    id: string;
  };
}

export interface PausedBatchState {
  assistantContent: string;
  toolCalls: OllamaToolCall[];
  nextToolIndex: number;
}

export interface ConversationSummary {
  _id: string;
  userId: string;
  projectId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

import type { ToolEntityLink, UiToolCallEnrichment } from '../utils/toolEntityLinks.js';

export type { ToolEntityLink, UiToolCallEnrichment };

export interface Conversation extends ConversationSummary {
  messages: StoredMessage[];
  pendingProposals?: PendingProposal[];
  pausedBatch?: PausedBatchState | null;
  resolvedProposals?: PendingProposal[];
  messageProposals?: Record<number, PendingProposal[]>;
  messageToolResults?: Record<number, UiToolCallEnrichment[]>;
}

export type AgentStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'status'; message: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  | {
      type: 'tool_result';
      name: string;
      success: boolean;
      content: string;
      entityLinks?: ToolEntityLink[];
    }
  | {
      type: 'tool_proposal';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      source: 'native' | 'text_fallback' | 'manual';
      staged?: boolean;
      stagedEntity?: {
        kind: 'task' | 'project';
        id: string;
      };
    }
  | { type: 'warning'; message: string }
  | { type: 'paused'; conversationId: string; pendingCount: number }
  | { type: 'error'; message: string }
  | { type: 'aborted'; conversationId: string }
  | { type: 'done'; conversationId: string; content: string; paused?: boolean };
