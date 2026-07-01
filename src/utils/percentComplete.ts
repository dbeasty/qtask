import type { Subtask, TaskStatus } from '../types/task.js';

export type ProgressField = 'percent' | 'hoursSpent' | 'hoursRemaining';

export interface PercentCompleteNode {
  status?: TaskStatus;
  percentComplete: number;
  percentCompleteOverride?: number | null;
  progressShare?: number | null;
  hoursSpent?: number | null;
  hoursRemaining?: number | null;
  lastProgressField?: ProgressField | null;
  subtasks?: PercentCompleteNode[];
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function effectiveLeafPercent(node: PercentCompleteNode): number {
  if (node.status === 'done') {
    return 100;
  }

  if (node.percentCompleteOverride !== undefined && node.percentCompleteOverride !== null) {
    return clampPercent(node.percentCompleteOverride);
  }

  const children = node.subtasks ?? [];
  if (children.length > 0) {
    return clampPercent(node.percentComplete);
  }

  const lastField = node.lastProgressField ?? 'percent';
  if (lastField === 'hoursSpent' || lastField === 'hoursRemaining') {
    const spent = node.hoursSpent ?? 0;
    const remaining = node.hoursRemaining ?? 0;
    const total = spent + remaining;
    if (total > 0) {
      return clampPercent((spent / total) * 100);
    }
  }

  return clampPercent(node.percentComplete);
}

export function normalizeShares(children: PercentCompleteNode[]): number[] {
  if (children.length === 0) return [];

  const explicit = children.map((child) =>
    child.progressShare !== undefined && child.progressShare !== null ? child.progressShare : null
  );
  const explicitSum = explicit.reduce<number>((sum, share) => sum + (share ?? 0), 0);
  const unsetCount = explicit.filter((share) => share === null).length;

  let shares: number[];
  if (unsetCount === 0) {
    shares = explicit.map((share) => share ?? 0);
    const total = shares.reduce((sum, share) => sum + share, 0);
    if (total > 0 && total !== 100) {
      shares = shares.map((share) => (share / total) * 100);
    } else if (total === 0) {
      shares = children.map(() => 100 / children.length);
    }
  } else {
    const remainder = Math.max(0, 100 - explicitSum);
    const equalShare = remainder / unsetCount;
    shares = explicit.map((share) => (share === null ? equalShare : share));
    const total = shares.reduce((sum, share) => sum + share, 0);
    if (total > 0 && total !== 100) {
      shares = shares.map((share) => (share / total) * 100);
    }
  }

  return shares;
}

export function computePercentComplete(node: PercentCompleteNode): number {
  if (node.percentCompleteOverride !== undefined && node.percentCompleteOverride !== null) {
    return clampPercent(node.percentCompleteOverride);
  }

  const children = node.subtasks ?? [];
  if (children.length === 0) {
    return effectiveLeafPercent(node);
  }

  const shares = normalizeShares(children);
  const weighted = children.reduce(
    (sum, child, index) => sum + computePercentComplete(child) * (shares[index] ?? 0),
    0
  );
  return clampPercent(weighted / 100);
}

export function syncStatusFromChildren(node: PercentCompleteNode): void {
  const children = node.subtasks ?? [];
  for (const child of children) {
    syncStatusFromChildren(child);
  }

  if (children.length === 0) return;

  const allDone = children.every((child) => child.status === 'done');
  const anyNotDone = children.some((child) => child.status !== 'done');

  if (allDone) {
    node.status = 'done';
    node.percentComplete = 100;
    node.lastProgressField = 'percent';
    node.percentCompleteOverride = undefined;
  } else if (node.status === 'done' && anyNotDone) {
    node.status = 'in_progress';
  }
}

export function applyPercentComplete<T extends PercentCompleteNode>(node: T): T {
  const children = (node.subtasks ?? []).map((child) =>
    applyPercentComplete(child as Subtask)
  ) as T['subtasks'];

  const updated = { ...node, subtasks: children };
  syncStatusFromChildren(updated);

  return {
    ...updated,
    percentComplete: computePercentComplete(updated),
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
