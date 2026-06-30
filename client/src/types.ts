export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  _id: string;
  userId: string;
  projectId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: string;
  tags: string[];
  percentComplete: number;
  subtasks: Subtask[];
  createdAt: string;
  updatedAt: string;
}

export interface Subtask {
  _id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  percentComplete: number;
  subtasks: Subtask[];
}

export interface Project {
  _id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  toolName?: string;
}

export interface PendingProposal {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  source: 'native' | 'text_fallback' | 'manual';
  status: 'pending' | 'approved' | 'rejected';
}

export interface ConversationSummary {
  _id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation extends ConversationSummary {
  messages: StoredMessage[];
  pendingProposals?: PendingProposal[];
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

export interface UiToolCall {
  name: string;
  success?: boolean;
  errorContent?: string;
}

export interface UiProposal {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  source: 'native' | 'text_fallback' | 'manual';
  status: 'pending' | 'approved' | 'rejected';
}

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: UiToolCall[];
  proposals?: UiProposal[];
  warnings?: string[];
  paused?: boolean;
  streaming?: boolean;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  projectId?: string;
}

export interface CreateSubtaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  projectId?: string | null;
}

export interface UpdateSubtaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
}
