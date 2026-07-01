import type { Subtask, Task } from '../types';

export function nodeKey(taskId: string, path: string[]): string {
  return path.length === 0 ? taskId : `${taskId}:${path.join('/')}`;
}

export function buildSubtaskPath(parentPath: string[], subtaskId: string): string[] {
  return [...parentPath, subtaskId];
}

export function isDescendantPath(ancestorPath: string[], path: string[]): boolean {
  if (path.length < ancestorPath.length) return false;
  return ancestorPath.every((id, index) => path[index] === id);
}

export function isInvalidAttachTarget(fromPath: string[], toParentPath: string[]): boolean {
  if (toParentPath.length < fromPath.length) return false;
  return fromPath.every((id, index) => toParentPath[index] === id);
}

export function findSubtaskByPath(subtasks: Subtask[], path: string[]): Subtask | null {
  let current: Subtask[] = subtasks;
  let node: Subtask | null = null;

  for (const id of path) {
    node = current.find((subtask) => subtask._id === id) ?? null;
    if (!node) return null;
    current = node.subtasks;
  }

  return node;
}

export function findPathBySubtaskId(
  subtasks: Subtask[],
  subtaskId: string,
  prefix: string[] = []
): string[] | null {
  for (const subtask of subtasks) {
    const path = [...prefix, subtask._id];
    if (subtask._id === subtaskId) return path;
    const nested = findPathBySubtaskId(subtask.subtasks, subtaskId, path);
    if (nested) return nested;
  }
  return null;
}

export interface SiblingContext {
  parentPath: string[];
  siblings: Subtask[];
  index: number;
}

export function getSiblingContext(task: Task, path: string[]): SiblingContext | null {
  if (path.length === 0) return null;

  const parentPath = path.slice(0, -1);
  const nodeId = path[path.length - 1]!;
  const siblings =
    parentPath.length === 0 ? task.subtasks : findSubtaskByPath(task.subtasks, parentPath)?.subtasks;

  if (!siblings) return null;

  const index = siblings.findIndex((s) => s._id === nodeId);
  if (index === -1) return null;

  return { parentPath, siblings, index };
}

export type MoveUpAction =
  | { kind: 'reorder'; parentPath: string[]; index: number }
  | { kind: 'outdent'; toParentPath: string[]; index: number }
  | { kind: 'promote' };

export function getMoveUpAction(task: Task, path: string[]): MoveUpAction | null {
  const ctx = getSiblingContext(task, path);
  if (!ctx) return null;

  if (ctx.index > 0) {
    return { kind: 'reorder', parentPath: ctx.parentPath, index: ctx.index - 1 };
  }

  if (path.length >= 2) {
    const parentCtx = getSiblingContext(task, path.slice(0, -1));
    if (!parentCtx) return null;
    return {
      kind: 'outdent',
      toParentPath: ctx.parentPath.slice(0, -1),
      index: parentCtx.index,
    };
  }

  if (path.length === 1) {
    return { kind: 'promote' };
  }

  return null;
}

export function canMoveUp(task: Task, path: string[]): boolean {
  return getMoveUpAction(task, path) !== null;
}

export interface AttachTarget {
  parentPath: string[];
  label: string;
}

export function collectAttachTargets(task: Task, fromPath: string[]): AttachTarget[] {
  const targets: AttachTarget[] = [{ parentPath: [], label: task.title }];

  function walk(subtasks: Subtask[], parentPath: string[], labels: string[]) {
    for (const subtask of subtasks) {
      const path = [...parentPath, subtask._id];
      const label = [...labels, subtask.title].join(' › ');
      if (!isInvalidAttachTarget(fromPath, path)) {
        targets.push({ parentPath: path, label });
      }
      walk(subtask.subtasks, path, [...labels, subtask.title]);
    }
  }

  walk(task.subtasks, [], [task.title]);
  return targets;
}

export function countNestedSubtasks(subtasks: Subtask[]): number {
  return subtasks.reduce((count, subtask) => count + 1 + countNestedSubtasks(subtask.subtasks), 0);
}

export function ancestorKeys(taskId: string, path: string[]): string[] {
  const keys: string[] = [nodeKey(taskId, [])];
  for (let i = 0; i < path.length; i++) {
    keys.push(nodeKey(taskId, path.slice(0, i + 1)));
  }
  return keys;
}
