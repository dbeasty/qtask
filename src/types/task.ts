export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskLinkType = 'related' | 'blocking' | 'blocked_by';
export type ProgressField = 'percent' | 'hoursSpent' | 'hoursRemaining';

export interface TaskLink {
  taskId: string;
  type: TaskLinkType;
}

export interface Subtask {
  _id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: Date;
  tags: string[];
  percentComplete: number;
  percentCompleteOverride?: number;
  progressShare?: number;
  hoursSpent?: number;
  hoursRemaining?: number;
  lastProgressField?: ProgressField;
  subtasks: Subtask[];
  links: TaskLink[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Task {
  _id: string;
  userId: string;
  /** @deprecated Prefer projectIds. */
  projectId?: string;
  projectIds: string[];
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: Date;
  tags: string[];
  percentComplete: number;
  percentCompleteOverride?: number;
  progressShare?: number;
  hoursSpent?: number;
  hoursRemaining?: number;
  lastProgressField?: ProgressField;
  subtasks: Subtask[];
  links: TaskLink[];
  assigneeId?: string;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | string;
  tags?: string[];
  percentComplete?: number;
  percentCompleteOverride?: number;
  progressShare?: number;
  hoursSpent?: number;
  hoursRemaining?: number;
  lastProgressField?: ProgressField;
  projectId?: string;
  projectIds?: string[];
  subtasks?: CreateSubtaskInput[];
}

export interface CreateSubtaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | string;
  tags?: string[];
  percentComplete?: number;
  percentCompleteOverride?: number;
  progressShare?: number;
  hoursSpent?: number;
  hoursRemaining?: number;
  lastProgressField?: ProgressField;
  subtasks?: CreateSubtaskInput[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | string | null;
  tags?: string[];
  percentComplete?: number;
  percentCompleteOverride?: number | null;
  progressShare?: number | null;
  hoursSpent?: number | null;
  hoursRemaining?: number | null;
  lastProgressField?: ProgressField | null;
  projectId?: string | null;
  projectIds?: string[] | null;
  assigneeId?: string | null;
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
  dueDate?: Date | string | null;
  tags?: string[];
  percentComplete?: number;
  percentCompleteOverride?: number | null;
  progressShare?: number | null;
  hoursSpent?: number | null;
  hoursRemaining?: number | null;
  lastProgressField?: ProgressField | null;
}

export interface TaskSearchFilters {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority | TaskPriority[];
  projectId?: string;
  assigneeId?: string;
  tags?: string[];
  dueBefore?: Date | string;
  dueAfter?: Date | string;
  query?: string;
}

export interface ActivityEntry {
  _id: string;
  taskId: string;
  userId: string;
  action: string;
  details: Record<string, unknown>;
  source: 'user' | 'ai' | 'system';
  createdAt: Date;
}

export interface EmbeddingJob {
  _id: string;
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}
