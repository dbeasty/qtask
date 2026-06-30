export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskLinkType = 'related' | 'blocking' | 'blocked_by';

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
  subtasks: Subtask[];
  links: TaskLink[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Task {
  _id: string;
  userId: string;
  projectId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: Date;
  tags: string[];
  percentComplete: number;
  percentCompleteOverride?: number;
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
  projectId?: string;
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
  projectId?: string | null;
  assigneeId?: string | null;
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
