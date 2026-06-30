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
}

export interface PendingProposal {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  source: 'native' | 'text_fallback' | 'manual';
  status: 'pending' | 'approved' | 'rejected';
  toolCallIndex?: number;
}

export interface PausedBatchState {
  assistantContent: string;
  toolCalls: OllamaToolCall[];
  nextToolIndex: number;
}

export interface ConversationSummary {
  _id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation extends ConversationSummary {
  messages: StoredMessage[];
  pendingProposals?: PendingProposal[];
  pausedBatch?: PausedBatchState | null;
  resolvedProposals?: PendingProposal[];
  messageProposals?: Record<number, PendingProposal[]>;
}

export type ChatStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; name: string; success: boolean; content: string }
  | {
      type: 'tool_proposal';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      source: 'native' | 'text_fallback' | 'manual';
    }
  | { type: 'warning'; message: string }
  | { type: 'paused'; conversationId: string; pendingCount: number }
  | { type: 'error'; message: string }
  | { type: 'done'; conversationId: string; content: string; paused?: boolean };
