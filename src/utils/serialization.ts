import type { CreateSubtaskInput, LaborLineInput, MaterialLineInput, TaskStepInput } from '../types/task.js';
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

export function normalizeMaterialsInput(
  materials: MaterialLineInput[] | undefined
): Array<{ _id?: Types.ObjectId; description: string; quantity: number; unitPrice: number }> {
  if (!materials) return [];
  return materials
    .map((line) => {
      let id: Types.ObjectId | undefined;
      if (line._id && Types.ObjectId.isValid(line._id)) {
        id = new Types.ObjectId(line._id);
      }
      return {
        _id: id,
        description: line.description.trim(),
        quantity: Math.max(0, Number(line.quantity) || 0),
        unitPrice: Math.max(0, Number(line.unitPrice) || 0),
      };
    })
    .filter((line) => line.description.length > 0);
}

export function sumLaborHours(laborLines: Array<{ hours: number }>): number {
  return laborLines.reduce((sum, line) => sum + Math.max(0, Number(line.hours) || 0), 0);
}

export function normalizeLaborLinesInput(
  laborLines: LaborLineInput[] | undefined
): Array<{ _id?: Types.ObjectId; description?: string; hours: number }> {
  if (!laborLines) return [];
  return laborLines
    .map((line) => {
      let id: Types.ObjectId | undefined;
      if (line._id && Types.ObjectId.isValid(line._id)) {
        id = new Types.ObjectId(line._id);
      }
      const hours = Math.max(0, Number(line.hours) || 0);
      const description = line.description?.trim();
      return {
        _id: id,
        description: description || undefined,
        hours,
      };
    })
    .filter((line) => line.hours > 0);
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
    hoursRemaining: input.hoursRemaining,
    lastProgressField: input.lastProgressField,
    materials: normalizeMaterialsInput(input.materials),
    laborLines: normalizeLaborLinesInput(input.laborLines),
    hoursSpent:
      input.laborLines !== undefined
        ? sumLaborHours(normalizeLaborLinesInput(input.laborLines))
        : input.hoursSpent,
    hourlyRate: input.hourlyRate,
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

function serializeMaterials(
  materials: Record<string, unknown>[] | undefined
): Record<string, unknown>[] {
  return (materials ?? []).map((line) => ({
    _id: String(line._id),
    description: String(line.description ?? ''),
    quantity: Number(line.quantity ?? 0),
    unitPrice: Number(line.unitPrice ?? 0),
  }));
}

function serializeLaborLines(
  laborLines: Record<string, unknown>[] | undefined
): Record<string, unknown>[] {
  return (laborLines ?? []).map((line) => ({
    _id: String(line._id),
    description: line.description ? String(line.description) : undefined,
    hours: Number(line.hours ?? 0),
  }));
}

export function serializeTask(doc: Record<string, unknown>): SerializedTask {
  const obj = typeof (doc as { toObject?: () => Record<string, unknown> }).toObject === 'function'
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : doc;

  const projectIds = normalizeTaskProjectIds(obj);
  // The raw doc's `embedding` vector is internal (semantic search only) —
  // never send it to clients.
  const { embedding: _embedding, ...rest } = obj;

  return {
    ...rest,
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
    materials: serializeMaterials(obj.materials as Record<string, unknown>[] | undefined),
    laborLines: serializeLaborLines(obj.laborLines as Record<string, unknown>[] | undefined),
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
    materials: serializeMaterials(subtask.materials as Record<string, unknown>[] | undefined),
    laborLines: serializeLaborLines(subtask.laborLines as Record<string, unknown>[] | undefined),
    subtasks: ((subtask.subtasks as Record<string, unknown>[]) ?? []).map(serializeSubtask),
  };
}

export interface SlimTaskForTool {
  _id: string;
  title: string;
  status: string;
  priority: string;
  percentComplete: number;
  projectIds: string[];
  projectId?: string;
  description?: string;
  dueDate?: string;
  tags?: string[];
  assigneeId?: string;
  subtaskCount?: number;
}

export interface SlimProjectForTool {
  _id: string;
  name: string;
  status: string;
  percentComplete: number;
  description?: string;
  ownerEmail?: string;
}

function countSubtasks(subtasks: unknown): number {
  if (!Array.isArray(subtasks)) return 0;
  return subtasks.reduce((sum, item) => {
    const subtask = item as Record<string, unknown>;
    return sum + 1 + countSubtasks(subtask.subtasks);
  }, 0);
}

/** Strip embeddings and heavy nested fields before sending tasks to the agent/MCP. */
export function slimTaskForTool(task: Record<string, unknown>): SlimTaskForTool {
  const projectIds = normalizeTaskProjectIds(task);
  const slim: SlimTaskForTool = {
    _id: String(task._id),
    title: String(task.title ?? ''),
    status: String(task.status ?? 'todo'),
    priority: String(task.priority ?? 'medium'),
    percentComplete: Number(task.percentComplete ?? 0),
    projectIds,
    projectId: projectIds[0],
  };

  if (task.description) slim.description = String(task.description);
  if (task.dueDate) slim.dueDate = new Date(task.dueDate as string).toISOString();
  if (Array.isArray(task.tags) && task.tags.length > 0) {
    slim.tags = task.tags.map(String);
  }
  if (task.assigneeId) slim.assigneeId = String(task.assigneeId);

  const subtaskCount = countSubtasks(task.subtasks);
  if (subtaskCount > 0) slim.subtaskCount = subtaskCount;

  return slim;
}

/** Strip permission flags and rollup noise before sending projects to the agent/MCP. */
export function slimProjectForTool(project: Record<string, unknown>): SlimProjectForTool {
  const slim: SlimProjectForTool = {
    _id: String(project._id),
    name: String(project.name ?? ''),
    status: String(project.status ?? 'todo'),
    percentComplete: Number(project.percentComplete ?? 0),
  };

  if (project.description) slim.description = String(project.description);
  if (project.ownerEmail) slim.ownerEmail = String(project.ownerEmail);

  return slim;
}

export function serializeComment(doc: {
  _id: unknown;
  taskId: string;
  subtaskPath?: string[];
  userId: string;
  body: string;
  parentId?: string;
  editedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}, author: { userId: string; email: string; displayName?: string }): import('../types/comment.js').Comment {
  return {
    _id: String(doc._id),
    taskId: doc.taskId,
    subtaskPath: doc.subtaskPath ?? [],
    userId: doc.userId,
    author,
    body: doc.body,
    parentId: doc.parentId ?? undefined,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    editedAt: doc.editedAt?.toISOString(),
  };
}
