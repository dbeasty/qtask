import type { TaskFormValues } from '../components/TaskForm';
import type { TaskPriority, TaskStatus } from '../types';

/**
 * Local backing store for a *not yet created* task or subtask.
 *
 * The create form only reaches the server on submit, so anything typed into it
 * used to vanish the moment the form closed — switching views unmounts
 * TasksPage, picking another task swaps the detail panel, and a reload dropped
 * it entirely. Drafts are mirrored to localStorage as the user types so the
 * form can be restored, and TasksPage additionally confirms before an explicit
 * close throws one away.
 */

const STORAGE_KEY = 'qtask_task_draft';
/** Drafts older than this are ignored on restore so a long-abandoned form does not reappear. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

export type TaskDraftScope =
  | { kind: 'task'; projectId: string }
  | { kind: 'subtask'; taskId: string; path: string[] };

export interface TaskDraftValues {
  title: string;
  description: string;
  steps: { text: string; done: boolean }[];
  status: TaskStatus;
  priority: TaskPriority;
  projectName: string;
  tags: string;
}

export interface TaskDraft {
  version: 1;
  scope: TaskDraftScope;
  values: TaskDraftValues;
  savedAt: number;
}

function randomKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function taskDraftScopesEqual(a: TaskDraftScope, b: TaskDraftScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'task' && b.kind === 'task') return a.projectId === b.projectId;
  if (a.kind === 'subtask' && b.kind === 'subtask') {
    return (
      a.taskId === b.taskId &&
      a.path.length === b.path.length &&
      a.path.every((segment, index) => segment === b.path[index])
    );
  }
  return false;
}

/**
 * Whether the form holds work worth keeping. `projectName` is excluded on
 * purpose: the task create form pre-fills it from the active project (and
 * create ignores it in favour of the project the form was opened for), so it
 * is not something the user typed.
 */
export function hasTaskDraftContent(values: TaskFormValues): boolean {
  return (
    values.title.trim().length > 0 ||
    values.description.trim().length > 0 ||
    values.tags.trim().length > 0 ||
    values.steps.some((step) => step.text.trim().length > 0) ||
    values.status !== 'todo' ||
    values.priority !== 'medium'
  );
}

function toDraftValues(values: TaskFormValues): TaskDraftValues {
  return {
    title: values.title,
    description: values.description,
    steps: values.steps
      .filter((step) => step.text.trim().length > 0)
      .map((step) => ({ text: step.text, done: step.done })),
    status: values.status,
    priority: values.priority,
    projectName: values.projectName,
    tags: values.tags,
  };
}

/** Overlays a stored draft onto freshly built empty form values. */
export function applyTaskDraft(base: TaskFormValues, draft: TaskDraft): TaskFormValues {
  return {
    ...base,
    title: draft.values.title,
    description: draft.values.description,
    // Mirrors newDraftStep(): a non-ObjectId `_id` is dropped by stepsForApi,
    // so restored steps are created fresh on submit.
    steps: draft.values.steps.map((step) => ({
      _id: `draft-${randomKey()}`,
      clientKey: `ck-${randomKey()}`,
      text: step.text,
      done: step.done,
    })),
    status: draft.values.status,
    priority: draft.values.priority,
    projectName: draft.values.projectName || base.projectName,
    tags: draft.values.tags,
  };
}

function isScope(value: unknown): value is TaskDraftScope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TaskDraftScope> & { projectId?: unknown; taskId?: unknown; path?: unknown };
  if (candidate.kind === 'task') {
    return typeof candidate.projectId === 'string' && candidate.projectId.length > 0;
  }
  if (candidate.kind === 'subtask') {
    return (
      typeof candidate.taskId === 'string' &&
      candidate.taskId.length > 0 &&
      Array.isArray(candidate.path) &&
      candidate.path.every((segment) => typeof segment === 'string')
    );
  }
  return false;
}

function normalizeDraft(raw: unknown, now: number): TaskDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<TaskDraft>;
  if (candidate.version !== 1) return null;
  if (!isScope(candidate.scope)) return null;
  if (typeof candidate.savedAt !== 'number' || now - candidate.savedAt > MAX_AGE_MS) return null;

  const values = candidate.values;
  if (!values || typeof values !== 'object') return null;

  const steps = Array.isArray(values.steps)
    ? values.steps
        .filter((step): step is { text: string; done: boolean } => Boolean(step) && typeof step.text === 'string')
        .map((step) => ({ text: step.text, done: step.done === true }))
    : [];

  return {
    version: 1,
    scope: candidate.scope,
    savedAt: candidate.savedAt,
    values: {
      title: typeof values.title === 'string' ? values.title : '',
      description: typeof values.description === 'string' ? values.description : '',
      steps,
      status: STATUSES.includes(values.status as TaskStatus) ? (values.status as TaskStatus) : 'todo',
      priority: PRIORITIES.includes(values.priority as TaskPriority)
        ? (values.priority as TaskPriority)
        : 'medium',
      projectName: typeof values.projectName === 'string' ? values.projectName : '',
      tags: typeof values.tags === 'string' ? values.tags : '',
    },
  };
}

export function readTaskDraft(now = Date.now()): TaskDraft | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeDraft(JSON.parse(raw), now);
  } catch {
    return null;
  }
}

function write(draft: TaskDraft): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

let pendingWrite: TaskDraft | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPending(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingWrite = null;
}

/**
 * Mirrors the form to storage. Empty forms clear the draft instead of storing
 * one, so closing an untouched form never leaves something to restore.
 */
export function saveTaskDraft(
  scope: TaskDraftScope,
  values: TaskFormValues,
  delayMs = 300,
  now = Date.now()
): void {
  if (!hasTaskDraftContent(values)) {
    // Only drop the stored draft when it belongs to this form; an empty form
    // must not wipe a draft another scope is still holding.
    cancelPending();
    const existing = readTaskDraft(now);
    if (existing && taskDraftScopesEqual(existing.scope, scope)) clearTaskDraft();
    return;
  }

  pendingWrite = { version: 1, scope, values: toDraftValues(values), savedAt: now };
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const draft = pendingWrite;
    pendingWrite = null;
    if (draft) write(draft);
  }, delayMs);
}

/** Commits a debounced draft immediately (unmount, tab hide, page unload). */
export function flushTaskDraft(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  const draft = pendingWrite;
  pendingWrite = null;
  if (draft) write(draft);
}

export function clearTaskDraft(): void {
  cancelPending();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}
