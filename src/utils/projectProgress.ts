import type { ProjectStatus } from '../types/project.js';
import type { TaskStatus } from '../types/task.js';
import { normalizeShares, type PercentCompleteNode } from './percentComplete.js';

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export interface ProgressChild {
  status: TaskStatus | ProjectStatus;
  percentComplete: number;
  progressShare?: number | null;
}

/**
 * Derive aggregate status from children (tasks or child projects).
 * all done → done; all cancelled → cancelled; any activity → in_progress; else todo.
 */
export function syncStatusFromProgressChildren(children: ProgressChild[]): ProjectStatus {
  if (children.length === 0) return 'todo';

  const allDone = children.every((child) => child.status === 'done');
  if (allDone) return 'done';

  const allCancelled = children.every((child) => child.status === 'cancelled');
  if (allCancelled) return 'cancelled';

  const anyActivity = children.some(
    (child) =>
      child.status === 'in_progress' ||
      child.status === 'done' ||
      (child.status !== 'cancelled' && child.percentComplete > 0)
  );
  if (anyActivity) return 'in_progress';

  return 'todo';
}

/** Equal-weight average of linked task percents; status from task statuses. */
export function computeLeafProjectProgress(tasks: ProgressChild[]): {
  percentComplete: number;
  status: ProjectStatus;
} {
  if (tasks.length === 0) {
    return { percentComplete: 0, status: 'todo' };
  }

  const sum = tasks.reduce((total, task) => total + clampPercent(task.percentComplete), 0);
  const percentComplete = clampPercent(sum / tasks.length);
  const status = syncStatusFromProgressChildren(tasks);
  return {
    percentComplete: status === 'done' ? 100 : percentComplete,
    status,
  };
}

/** Weighted rollup of child projects using progressShare (same model as task subtasks). */
export function computeParentProjectProgress(children: ProgressChild[]): {
  percentComplete: number;
  status: ProjectStatus;
} {
  if (children.length === 0) {
    return { percentComplete: 0, status: 'todo' };
  }

  const nodes: PercentCompleteNode[] = children.map((child) => ({
    status: child.status,
    percentComplete: child.percentComplete,
    progressShare: child.progressShare,
  }));
  const shares = normalizeShares(nodes);
  const weighted = children.reduce(
    (sum, child, index) => sum + clampPercent(child.percentComplete) * (shares[index] ?? 0),
    0
  );
  const status = syncStatusFromProgressChildren(children);
  return {
    percentComplete: status === 'done' ? 100 : clampPercent(weighted / 100),
    status,
  };
}
