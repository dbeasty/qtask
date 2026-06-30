import type { CreateSubtaskInput } from '../types/task.js';

export function buildSubtaskTree(input: CreateSubtaskInput): Record<string, unknown> {
  return {
    title: input.title,
    description: input.description,
    status: input.status ?? 'todo',
    priority: input.priority ?? 'medium',
    dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
    tags: input.tags ?? [],
    percentComplete: input.percentComplete ?? 0,
    percentCompleteOverride: input.percentCompleteOverride,
    subtasks: (input.subtasks ?? []).map(buildSubtaskTree),
    links: [],
  };
}

export type SerializedTask = Record<string, unknown> & {
  _id: string;
  title: string;
  status: string;
  priority: string;
  percentComplete: number;
  dueDate?: string;
  subtasks: Record<string, unknown>[];
};

export function serializeTask(doc: Record<string, unknown>): SerializedTask {
  const obj = typeof (doc as { toObject?: () => Record<string, unknown> }).toObject === 'function'
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : doc;

  return {
    ...obj,
    _id: String(obj._id),
    title: String(obj.title ?? ''),
    status: String(obj.status ?? 'todo'),
    priority: String(obj.priority ?? 'medium'),
    percentComplete: Number(obj.percentComplete ?? 0),
    dueDate: obj.dueDate ? new Date(obj.dueDate as string).toISOString() : undefined,
    createdAt: obj.createdAt ? new Date(obj.createdAt as string).toISOString() : undefined,
    updatedAt: obj.updatedAt ? new Date(obj.updatedAt as string).toISOString() : undefined,
    subtasks: ((obj.subtasks as Record<string, unknown>[]) ?? []).map(serializeSubtask),
  };
}

function serializeSubtask(subtask: Record<string, unknown>): Record<string, unknown> {
  return {
    ...subtask,
    _id: String(subtask._id),
    dueDate: subtask.dueDate ? new Date(subtask.dueDate as string).toISOString() : undefined,
    createdAt: subtask.createdAt ? new Date(subtask.createdAt as string).toISOString() : undefined,
    updatedAt: subtask.updatedAt ? new Date(subtask.updatedAt as string).toISOString() : undefined,
    subtasks: ((subtask.subtasks as Record<string, unknown>[]) ?? []).map(serializeSubtask),
  };
}
