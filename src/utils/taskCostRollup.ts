import type { CostRollupTotals, MaterialLine, ProjectRates } from '../types/task.js';
import { normalizeShares, type PercentCompleteNode } from './percentComplete.js';

export interface CostNode {
  title?: string;
  hoursSpent?: number | null;
  hoursRemaining?: number | null;
  materials?: MaterialLine[];
  hourlyRate?: number | null;
  progressShare?: number | null;
  subtasks?: CostNode[];
}

export interface TaskTrackingLine {
  taskId: string;
  title: string;
  path?: string;
  hoursSpent: number;
  hoursRemaining: number;
  materials: MaterialLine[];
  materialsTotal: number;
  laborCost: number;
  totalCost: number;
}

export interface ExpenseTreeNode {
  taskId: string;
  title: string;
  path: string[];
  isLeaf: boolean;
  rollup: CostRollupTotals;
  ownRollup: CostRollupTotals;
  children: ExpenseTreeNode[];
}

function num(value: number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function materialsTotal(materials: MaterialLine[] | undefined): number {
  return (materials ?? []).reduce(
    (sum, line) => sum + num(line.quantity) * num(line.unitPrice),
    0
  );
}

export function effectiveRates(node: CostNode, projectRates: ProjectRates) {
  return {
    hourlyRate: num(node.hourlyRate ?? projectRates.hourlyRate ?? projectRates.userHourlyRate),
  };
}

export function computeLeafCost(node: CostNode, projectRates: ProjectRates): CostRollupTotals {
  const rates = effectiveRates(node, projectRates);
  const spent = num(node.hoursSpent);
  const remaining = num(node.hoursRemaining);
  const matTotal = materialsTotal(node.materials);
  const laborCost = (spent + remaining) * rates.hourlyRate;

  return {
    hoursSpent: spent,
    hoursRemaining: remaining,
    materialsTotal: matTotal,
    laborCost,
    totalCost: matTotal + laborCost,
  };
}

export function sumCostRollups(rollups: CostRollupTotals[]): CostRollupTotals {
  return rollups.reduce(
    (acc, rollup) => ({
      hoursSpent: acc.hoursSpent + rollup.hoursSpent,
      hoursRemaining: acc.hoursRemaining + rollup.hoursRemaining,
      materialsTotal: acc.materialsTotal + rollup.materialsTotal,
      laborCost: acc.laborCost + rollup.laborCost,
      totalCost: acc.totalCost + rollup.totalCost,
    }),
    {
      hoursSpent: 0,
      hoursRemaining: 0,
      materialsTotal: 0,
      laborCost: 0,
      totalCost: 0,
    }
  );
}

export function computeTaskCostRollup(node: CostNode, projectRates: ProjectRates): CostRollupTotals {
  const own = computeLeafCost(node, projectRates);
  const children = node.subtasks ?? [];
  if (children.length === 0) {
    return own;
  }
  const childTotal = sumCostRollups(children.map((child) => computeTaskCostRollup(child, projectRates)));
  return sumCostRollups([own, childTotal]);
}

export function weightedCostRollup(
  children: Array<{ rollup: CostRollupTotals; progressShare?: number | null }>
): CostRollupTotals {
  if (children.length === 0) {
    return {
      hoursSpent: 0,
      hoursRemaining: 0,
      materialsTotal: 0,
      laborCost: 0,
      totalCost: 0,
    };
  }

  const shareNodes: PercentCompleteNode[] = children.map((child) => ({
    percentComplete: 0,
    progressShare: child.progressShare,
  }));
  const shares = normalizeShares(shareNodes);

  const result: CostRollupTotals = {
    hoursSpent: 0,
    hoursRemaining: 0,
    materialsTotal: 0,
    laborCost: 0,
    totalCost: 0,
  };

  children.forEach((child, index) => {
    const weight = (shares[index] ?? 0) / 100;
    result.hoursSpent += child.rollup.hoursSpent * weight;
    result.hoursRemaining += child.rollup.hoursRemaining * weight;
    result.materialsTotal += child.rollup.materialsTotal * weight;
    result.laborCost += child.rollup.laborCost * weight;
    result.totalCost += child.rollup.totalCost * weight;
  });

  return result;
}

function serializeMaterials(raw: unknown): MaterialLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((line) => {
    const obj = line as Record<string, unknown>;
    return {
      _id: String(obj._id ?? ''),
      description: String(obj.description ?? ''),
      quantity: num(obj.quantity as number),
      unitPrice: num(obj.unitPrice as number),
    };
  });
}

function toCostNode(raw: Record<string, unknown>): CostNode {
  return {
    title: String(raw.title ?? ''),
    hoursSpent: raw.hoursSpent as number | undefined,
    hoursRemaining: raw.hoursRemaining as number | undefined,
    materials: serializeMaterials(raw.materials),
    hourlyRate: raw.hourlyRate as number | undefined,
    progressShare: raw.progressShare as number | undefined,
    subtasks: Array.isArray(raw.subtasks)
      ? (raw.subtasks as Record<string, unknown>[]).map(toCostNode)
      : [],
  };
}

function collectLeafLinesFromNode(
  node: CostNode,
  projectRates: ProjectRates,
  taskId: string,
  pathParts: string[]
): TaskTrackingLine[] {
  const children = node.subtasks ?? [];
  if (children.length === 0) {
    const cost = computeLeafCost(node, projectRates);
    return [
      {
        taskId,
        title: node.title ?? pathParts[pathParts.length - 1] ?? 'Task',
        path: pathParts.length > 1 ? pathParts.join(' › ') : undefined,
        hoursSpent: cost.hoursSpent,
        hoursRemaining: cost.hoursRemaining,
        materials: node.materials ?? [],
        materialsTotal: cost.materialsTotal,
        laborCost: cost.laborCost,
        totalCost: cost.totalCost,
      },
    ];
  }

  return children.flatMap((child) =>
    collectLeafLinesFromNode(child, projectRates, taskId, [...pathParts, child.title ?? 'Subtask'])
  );
}

export function collectTaskTrackingLines(
  task: Record<string, unknown>,
  projectRates: ProjectRates
): TaskTrackingLine[] {
  const taskId = String(task._id);
  const root = toCostNode(task);
  const children = root.subtasks ?? [];
  if (children.length === 0) {
    return collectLeafLinesFromNode(root, projectRates, taskId, [root.title ?? 'Task']);
  }
  return children.flatMap((child) =>
    collectLeafLinesFromNode(child, projectRates, taskId, [root.title ?? 'Task', child.title ?? 'Subtask'])
  );
}

export function buildExpenseTree(
  taskId: string,
  subtasks: Record<string, unknown>[],
  projectRates: ProjectRates,
  pathPrefix: string[] = []
): ExpenseTreeNode[] {
  return subtasks.map((raw) => {
    const node = toCostNode(raw);
    const subtaskId = String(raw._id ?? '');
    const path = [...pathPrefix, subtaskId];
    const childRaws = Array.isArray(raw.subtasks)
      ? (raw.subtasks as Record<string, unknown>[])
      : [];
    const ownRollup = computeLeafCost(node, projectRates);
    const rollup = computeTaskCostRollup(node, projectRates);
    return {
      taskId,
      title: node.title ?? 'Subtask',
      path,
      isLeaf: childRaws.length === 0,
      ownRollup,
      rollup,
      children:
        childRaws.length > 0 ? buildExpenseTree(taskId, childRaws, projectRates, path) : [],
    };
  });
}

export function buildTaskExpenseTree(
  task: Record<string, unknown>,
  projectRates: ProjectRates
): ExpenseTreeNode[] {
  const taskId = String(task._id);
  const subtasks = task.subtasks;
  const title = String(task.title ?? 'Task');
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    const node = toCostNode(task);
    const rollup = computeTaskCostRollup(node, projectRates);
    return [
      {
        taskId,
        title,
        path: [],
        isLeaf: true,
        ownRollup: computeLeafCost(node, projectRates),
        rollup,
        children: [],
      },
    ];
  }
  return buildExpenseTree(taskId, subtasks as Record<string, unknown>[], projectRates);
}
