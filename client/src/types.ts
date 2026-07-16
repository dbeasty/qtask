export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type ProgressField = 'percent' | 'hoursSpent' | 'hoursRemaining';

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
  percentCompleteOverride?: number;
  progressShare?: number;
  hoursSpent?: number;
  hoursRemaining?: number;
  lastProgressField?: ProgressField;
  subtasks: Subtask[];
  sortOrder?: number;
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
  percentCompleteOverride?: number;
  progressShare?: number;
  hoursSpent?: number;
  hoursRemaining?: number;
  lastProgressField?: ProgressField;
  subtasks: Subtask[];
}

export type CollaboratorRole = 'editor' | 'executor' | 'viewer';
export type ProjectRole = 'owner' | CollaboratorRole;

export interface ProjectCollaborator {
  userId: string;
  email: string;
  displayName?: string;
  role: CollaboratorRole;
}

export interface Project {
  _id: string;
  userId: string;
  ownerEmail: string;
  ownerDisplayName?: string;
  name: string;
  description?: string;
  role: ProjectRole;
  canEdit: boolean;
  canUpdateStatus: boolean;
  canManageMembers: boolean;
  collaborators: ProjectCollaborator[];
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
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  stagedEntity?: {
    kind: 'task' | 'project';
    id: string;
  };
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
      staged?: boolean;
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
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  staged?: boolean;
  stagedEntity?: {
    kind: 'task' | 'project';
    id: string;
  };
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
  percentComplete?: number;
  percentCompleteOverride?: number | null;
  progressShare?: number | null;
  hoursSpent?: number | null;
  hoursRemaining?: number | null;
  lastProgressField?: ProgressField | null;
}

export interface MoveSubtaskInput {
  fromPath: string[];
  toParentPath: string[];
  index?: number;
}

export interface AttachTaskAsSubtaskInput {
  sourceTaskId: string;
  parentPath: string[];
  index?: number;
}

export interface UpdateSubtaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  percentComplete?: number;
  percentCompleteOverride?: number | null;
  progressShare?: number | null;
  hoursSpent?: number | null;
  hoursRemaining?: number | null;
  lastProgressField?: ProgressField | null;
}
