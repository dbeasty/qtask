import type { CostRollupTotals, ExpenseTreeNode, MaterialLine, ProjectRates, Subtask, Task } from '../types';

interface CostNode {
  title?: string;
  hoursSpent?: number;
  hoursRemaining?: number;
  materials?: MaterialLine[];
  hourlyRate?: number;
  subtasks?: CostNode[];
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

function effectiveRates(node: CostNode, projectRates: ProjectRates) {
  return {
    hourlyRate: num(node.hourlyRate ?? projectRates.hourlyRate ?? projectRates.userHourlyRate),
  };
}

function computeLeafCost(node: CostNode, projectRates: ProjectRates): CostRollupTotals {
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

function sumCostRollups(rollups: CostRollupTotals[]): CostRollupTotals {
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

export function computeNodeCostRollup(node: CostNode, projectRates: ProjectRates): CostRollupTotals {
  const own = computeLeafCost(node, projectRates);
  const children = node.subtasks ?? [];
  if (children.length === 0) {
    return own;
  }
  const childTotal = sumCostRollups(children.map((child) => computeNodeCostRollup(child, projectRates)));
  return sumCostRollups([own, childTotal]);
}

function toCostNodeFromSubtask(subtask: Subtask): CostNode {
  return {
    title: subtask.title,
    hoursSpent: subtask.hoursSpent,
    hoursRemaining: subtask.hoursRemaining,
    materials: subtask.materials,
    hourlyRate: subtask.hourlyRate,
    subtasks: subtask.subtasks?.map(toCostNodeFromSubtask),
  };
}

export function computeTaskCostRollup(task: Task | Subtask, projectRates: ProjectRates): CostRollupTotals {
  return computeNodeCostRollup(
    {
      title: task.title,
      hoursSpent: task.hoursSpent,
      hoursRemaining: task.hoursRemaining,
      materials: task.materials,
      hourlyRate: task.hourlyRate,
      subtasks: task.subtasks?.map(toCostNodeFromSubtask),
    },
    projectRates
  );
}

export function buildExpenseTree(
  taskId: string,
  subtasks: Subtask[],
  projectRates: ProjectRates,
  pathPrefix: string[] = []
): ExpenseTreeNode[] {
  return subtasks.map((subtask) => {
    const path = [...pathPrefix, subtask._id];
    const children = subtask.subtasks ?? [];
    const ownRollup = computeLeafCost(
      {
        hoursSpent: subtask.hoursSpent,
        hoursRemaining: subtask.hoursRemaining,
        materials: subtask.materials,
        hourlyRate: subtask.hourlyRate,
      },
      projectRates
    );
    const rollup = computeTaskCostRollup(subtask, projectRates);
    return {
      taskId,
      title: subtask.title,
      path,
      isLeaf: children.length === 0,
      ownRollup,
      rollup,
      children:
        children.length > 0 ? buildExpenseTree(taskId, children, projectRates, path) : [],
    };
  });
}

export function buildTaskExpenseTree(task: Task, projectRates: ProjectRates): ExpenseTreeNode[] {
  const children = task.subtasks ?? [];
  if (children.length === 0) {
    const rollup = computeTaskCostRollup(task, projectRates);
    return [
      {
        taskId: task._id,
        title: task.title,
        path: [],
        isLeaf: true,
        ownRollup: computeLeafCost(
          {
            hoursSpent: task.hoursSpent,
            hoursRemaining: task.hoursRemaining,
            materials: task.materials,
            hourlyRate: task.hourlyRate,
          },
          projectRates
        ),
        rollup,
        children: [],
      },
    ];
  }
  return buildExpenseTree(task._id, children, projectRates);
}

export function computeFormCostSummary(
  values: {
    hoursSpent: string;
    hoursRemaining: string;
    hourlyRate: string;
    materials: MaterialLine[];
    laborLines?: import('../types').LaborLine[];
  },
  projectRates: ProjectRates
): CostRollupTotals {
  const laborSpent =
    values.laborLines && values.laborLines.length > 0
      ? values.laborLines.reduce((sum, line) => sum + num(line.hours), 0)
      : parseOptionalNumber(values.hoursSpent);
  return computeLeafCost(
    {
      hoursSpent: laborSpent,
      hoursRemaining: parseOptionalNumber(values.hoursRemaining),
      hourlyRate: parseOptionalNumber(values.hourlyRate) || projectRates.hourlyRate || projectRates.userHourlyRate,
      materials: values.materials,
    },
    projectRates
  );
}

export function deriveHoursProgressPercent(
  hoursSpent: number,
  hoursRemaining: number,
  status?: string
): number {
  if (status === 'done') return 100;
  const total = hoursSpent + hoursRemaining;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((hoursSpent / total) * 100)));
}

function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function formatMoney(value: number): string {
  return value.toFixed(2);
}

export function filterNonZeroExpenseNodes(nodes: ExpenseTreeNode[]): ExpenseTreeNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: filterNonZeroExpenseNodes(node.children),
    }))
    .filter((node) => node.rollup.totalCost > 0 || node.children.length > 0);
}
