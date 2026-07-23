import type { ExpenseTreeNode, Project } from '../types';

export function shouldExpandTrackingSection(input: {
  status?: string;
  priorityNotMedium?: boolean;
  hasMaterials?: boolean;
  hasLaborOrEstimate?: boolean;
  hasHourlyRate?: boolean;
  hasHoursSpent?: boolean;
  totalCost?: number;
  trackExpenses?: boolean;
}): boolean {
  if (input.status === 'in_progress') return true;
  if (input.priorityNotMedium) return true;
  if (input.hasMaterials) return true;
  if (input.hasLaborOrEstimate) return true;
  if (input.hasHourlyRate) return true;
  if (input.trackExpenses && input.hasHoursSpent) return true;
  if ((input.totalCost ?? 0) > 0) return true;
  return false;
}

export function shouldExpandProjectTrackingOnLoad(
  project: Project,
  trackExpenses: boolean,
  trackingTree: ExpenseTreeNode[]
): boolean {
  const rollup = project.trackingRollup;
  return (
    shouldExpandTrackingSection({
      status: project.status,
      hasMaterials: (rollup?.materialsTotal ?? 0) > 0,
      hasLaborOrEstimate:
        (rollup?.hoursRemaining ?? 0) > 0 ||
        (rollup?.laborCost ?? 0) > 0 ||
        (rollup?.hoursSpent ?? 0) > 0,
      hasHourlyRate: (project.hourlyRate ?? 0) > 0,
      hasHoursSpent: (rollup?.hoursSpent ?? 0) > 0,
      totalCost: rollup?.totalCost,
      trackExpenses,
    }) || trackingTree.length > 0
  );
}
