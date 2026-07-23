import type { CreateSubtaskInput, TaskStepInput } from '../types/task.js';
import { Types } from 'mongoose';

export function normalizeStepsInput(steps: TaskStepInput[] | undefined): Array<{ _id?: Types.ObjectId; text: string; done: boolean }> {
  if (!steps) return [];
  return steps
    .map((step) => {
      let id: Types.ObjectId | undefined;
      if (step._id && Types.ObjectId.isValid(step._id)) {
        id = new Types.ObjectId(step._id);
      }
      return {
        _id: id,
        text: step.text.trim(),
        done: Boolean(step.done),
      };
    })
    .filter((step) => step.text.length > 0);
}

export function buildSubtaskTree(input: CreateSubtaskInput): Record<string, unknown> {
  return {
    title: input.title,
    description: input.description,
    steps: normalizeStepsInput(input.steps),
    status: input.status ?? 'todo',
    priority: input.priority ?? 'medium',
    dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
    tags: input.tags ?? [],
    percentComplete: input.percentComplete ?? 0,
    percentCompleteOverride: input.percentCompleteOverride,
    progressShare: input.progressShare,
    hoursSpent: input.hoursSpent,
    hoursRemaining: input.hoursRemaining,
    lastProgressField: input.lastProgressField,
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
  projectIds: string[];
  dueDate?: string;
  subtasks: Record<string, unknown>[];
};

/** Normalize legacy projectId into projectIds for API responses. */
export function normalizeTaskProjectIds(obj: Record<string, unknown>): string[] {
  const fromArray = Array.isArray(obj.projectIds)
    ? (obj.projectIds as unknown[]).map(String).filter(Boolean)
    : [];
  if (fromArray.length > 0) return [...new Set(fromArray)];
  if (obj.projectId) return [String(obj.projectId)];
  return [];
}

function serializeSteps(steps: Record<string, unknown>[] | undefined): Record<string, unknown>[] {
  return (steps ?? []).map((step) => ({
    _id: String(step._id),
    text: String(step.text ?? ''),
    done: Boolean(step.done),
  }));
}

export function serializeTask(doc: Record<string, unknown>): SerializedTask {
  const obj = typeof (doc as { toObject?: () => Record<string, unknown> }).toObject === 'function'
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : doc;

  const projectIds = normalizeTaskProjectIds(obj);

  return {
    ...obj,
    _id: String(obj._id),
    title: String(obj.title ?? ''),
    status: String(obj.status ?? 'todo'),
    priority: String(obj.priority ?? 'medium'),
    percentComplete: Number(obj.percentComplete ?? 0),
    projectIds,
    projectId: projectIds[0],
    dueDate: obj.dueDate ? new Date(obj.dueDate as string).toISOString() : undefined,
    createdAt: obj.createdAt ? new Date(obj.createdAt as string).toISOString() : undefined,
    updatedAt: obj.updatedAt ? new Date(obj.updatedAt as string).toISOString() : undefined,
    steps: serializeSteps(obj.steps as Record<string, unknown>[] | undefined),
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
    steps: serializeSteps(subtask.steps as Record<string, unknown>[] | undefined),
    subtasks: ((subtask.subtasks as Record<string, unknown>[]) ?? []).map(serializeSubtask),
  };
}
