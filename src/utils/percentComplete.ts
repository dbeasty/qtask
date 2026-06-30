import type { Subtask } from '../types/task.js';

export interface PercentCompleteNode {
  percentComplete: number;
  percentCompleteOverride?: number | null;
  subtasks?: PercentCompleteNode[];
}

export function computePercentComplete(node: PercentCompleteNode): number {
  if (node.percentCompleteOverride !== undefined && node.percentCompleteOverride !== null) {
    return clampPercent(node.percentCompleteOverride);
  }

  const children = node.subtasks ?? [];
  if (children.length === 0) {
    return clampPercent(node.percentComplete);
  }

  const total = children.reduce((sum, child) => sum + computePercentComplete(child), 0);
  return Math.round(total / children.length);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function applyPercentComplete<T extends PercentCompleteNode>(node: T): T {
  return {
    ...node,
    percentComplete: computePercentComplete(node),
    subtasks: (node.subtasks ?? []).map((child) =>
      applyPercentComplete(child as Subtask)
    ) as T['subtasks'],
  };
}

export function countSubtasks(subtasks: Subtask[] = []): number {
  return subtasks.reduce((count, subtask) => {
    return count + 1 + countSubtasks(subtask.subtasks);
  }, 0);
}

export function flattenSubtasks(subtasks: Subtask[], depth = 0): Array<Subtask & { depth: number }> {
  const result: Array<Subtask & { depth: number }> = [];
  for (const subtask of subtasks) {
    result.push({ ...subtask, depth });
    if (subtask.subtasks?.length) {
      result.push(...flattenSubtasks(subtask.subtasks, depth + 1));
    }
  }
  return result;
}
