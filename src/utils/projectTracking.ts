import type { ProjectTrackingRollup } from '../types/project.js';
import type { ProjectRates } from '../types/task.js';
import {
  buildTaskExpenseTree,
  collectTaskTrackingLines,
  computeTaskCostRollup,
  sumCostRollups,
  weightedCostRollup,
  type CostNode,
  type ExpenseTreeNode,
  type TaskTrackingLine,
} from './taskCostRollup.js';

export type { ExpenseTreeNode, TaskTrackingLine };

export interface ProjectTrackingResult {
  hourlyRate?: number;
  totals: Omit<ProjectTrackingRollup, 'updatedAt'>;
  lines: TaskTrackingLine[];
  tree: ExpenseTreeNode[];
}

function toCostNodeFromTask(raw: Record<string, unknown>): CostNode {
  return {
    title: String(raw.title ?? ''),
    hoursSpent: raw.hoursSpent as number | undefined,
    hoursRemaining: raw.hoursRemaining as number | undefined,
    materials: Array.isArray(raw.materials)
      ? (raw.materials as Array<Record<string, unknown>>).map((line) => ({
          _id: String(line._id ?? ''),
          description: String(line.description ?? ''),
          quantity: Number(line.quantity ?? 0),
          unitPrice: Number(line.unitPrice ?? 0),
        }))
      : [],
    hourlyRate: raw.hourlyRate as number | undefined,
    progressShare: raw.progressShare as number | undefined,
    subtasks: Array.isArray(raw.subtasks)
      ? (raw.subtasks as Record<string, unknown>[]).map(toCostNodeFromTask)
      : [],
  };
}

export function computeLeafProjectTracking(
  tasks: Record<string, unknown>[],
  projectRates: ProjectRates
): ProjectTrackingResult {
  const lines = tasks.flatMap((task) => collectTaskTrackingLines(task, projectRates));
  const tree = tasks.flatMap((task) => buildTaskExpenseTree(task, projectRates));
  const totals = sumCostRollups(
    tasks.map((task) => computeTaskCostRollup(toCostNodeFromTask(task), projectRates))
  );

  return {
    hourlyRate: projectRates.hourlyRate,
    totals,
    lines,
    tree,
  };
}

export function computeParentProjectTracking(
  childProjects: Array<{
    progressShare?: number | null;
    trackingRollup?: ProjectTrackingRollup | null;
  }>,
  projectRates: ProjectRates
): ProjectTrackingResult {
  const children = childProjects
    .filter((child) => child.trackingRollup)
    .map((child) => ({
      progressShare: child.progressShare,
      rollup: {
        hoursSpent: child.trackingRollup!.hoursSpent,
        hoursRemaining: child.trackingRollup!.hoursRemaining,
        materialsTotal: child.trackingRollup!.materialsTotal,
        laborCost: child.trackingRollup!.laborCost,
        totalCost: child.trackingRollup!.totalCost,
      },
    }));

  return {
    hourlyRate: projectRates.hourlyRate,
    totals: weightedCostRollup(children),
    lines: [],
    tree: [],
  };
}

export function toStoredTrackingRollup(
  totals: Omit<ProjectTrackingRollup, 'updatedAt'>
): ProjectTrackingRollup {
  return {
    ...totals,
    updatedAt: new Date().toISOString(),
  };
}
