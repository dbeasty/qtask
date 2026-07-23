export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type ProgressField = 'percent' | 'hoursSpent' | 'hoursRemaining';

export interface TaskStep {
  _id?: string;
  /** Stable client-side key for React list identity; survives server _id assignment. */
  clientKey?: string;
  text: string;
  done: boolean;
}

export interface TaskStepInput {
  _id?: string;
  text: string;
  done?: boolean;
}

export interface MaterialLine {
  _id?: string;
  clientKey?: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface MaterialLineInput {
  _id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface LaborLine {
  _id?: string;
  clientKey?: string;
  description?: string;
  hours: number;
}

export interface LaborLineInput {
  _id?: string;
  description?: string;
  hours: number;
}

export interface CostRollupTotals {
  hoursSpent: number;
  hoursRemaining: number;
  materialsTotal: number;
  laborCost: number;
  totalCost: number;
}

export interface ProjectRates {
  hourlyRate?: number;
  userHourlyRate?: number;
}

export interface Task {
  _id: string;
  userId: string;
  /** @deprecated Prefer projectIds. */
  projectId?: string;
  projectIds: string[];
  title: string;
  description?: string;
  steps?: TaskStep[];
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
  materials?: MaterialLine[];
  laborLines?: LaborLine[];
  hourlyRate?: number;
  subtasks: Subtask[];
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Subtask {
  _id: string;
  title: string;
  description?: string;
  steps?: TaskStep[];
  status: TaskStatus;
  priority: TaskPriority;
  percentComplete: number;
  percentCompleteOverride?: number;
  progressShare?: number;
  hoursSpent?: number;
  hoursRemaining?: number;
  lastProgressField?: ProgressField;
  materials?: MaterialLine[];
  laborLines?: LaborLine[];
  hourlyRate?: number;
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

export interface ExpenseTreeNode {
  taskId: string;
  title: string;
  path: string[];
  isLeaf: boolean;
  rollup: CostRollupTotals;
  ownRollup: CostRollupTotals;
  children: ExpenseTreeNode[];
}

export interface ProjectTrackingRollup {
  hoursSpent: number;
  hoursRemaining: number;
  materialsTotal: number;
  laborCost: number;
  totalCost: number;
  updatedAt: string;
}

export interface ProjectTrackingLine {
  taskId: string;
  title: string;
  path?: string;
  hoursSpent: number;
  hoursRemaining: number;
  materials: MaterialLine[];
  materialsTotal: number;
  laborCost: number;
  totalCost: number;
}

export interface ProjectTrackingResult {
  hourlyRate?: number;
  trackingRollup: ProjectTrackingRollup;
  totals: Omit<ProjectTrackingRollup, 'updatedAt'>;
  lines: ProjectTrackingLine[];
  tree: ExpenseTreeNode[];
}

export interface Project {
  _id: string;
  userId: string;
  ownerEmail: string;
  ownerDisplayName?: string;
  name: string;
  description?: string;
  parentId?: string | null;
  sortOrder: number;
  status: TaskStatus;
  percentComplete: number;
  progressShare?: number;
  hourlyRate?: number;
  trackingRollup?: ProjectTrackingRollup;
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
  projectId?: string;
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
  steps?: TaskStepInput[];
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  projectId?: string;
  projectIds?: string[];
}

export interface CreateSubtaskInput {
  title: string;
  description?: string;
  steps?: TaskStepInput[];
  status?: TaskStatus;
  priority?: TaskPriority;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  steps?: TaskStepInput[];
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  projectId?: string | null;
  projectIds?: string[] | null;
  percentComplete?: number;
  percentCompleteOverride?: number | null;
  progressShare?: number | null;
  hoursSpent?: number | null;
  hoursRemaining?: number | null;
  lastProgressField?: ProgressField | null;
  materials?: MaterialLineInput[];
  laborLines?: LaborLineInput[];
  hourlyRate?: number | null;
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
  steps?: TaskStepInput[];
  status?: TaskStatus;
  priority?: TaskPriority;
  percentComplete?: number;
  percentCompleteOverride?: number | null;
  progressShare?: number | null;
  hoursSpent?: number | null;
  hoursRemaining?: number | null;
  lastProgressField?: ProgressField | null;
  materials?: MaterialLineInput[];
  laborLines?: LaborLineInput[];
  hourlyRate?: number | null;
}
