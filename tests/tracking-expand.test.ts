import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  shouldExpandDescriptionOnLoad,
  shouldExpandNotesOnLoad,
  shouldExpandProjectTrackingOnLoad,
  shouldExpandTrackingSection,
} from '../client/src/utils/trackingExpand.ts';
import type { ExpenseTreeNode, Project } from '../client/src/types.ts';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    _id: 'p1',
    userId: 'u1',
    ownerEmail: 'owner@example.com',
    name: 'A Project',
    sortOrder: 0,
    status: 'todo',
    percentComplete: 0,
    role: 'owner',
    canEdit: true,
    canUpdateStatus: true,
    canManageMembers: true,
    canManageStructure: true,
    canDeleteProjects: true,
    canDeleteOwnTasks: true,
    collaborators: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Project;
}

describe('trackingExpand', () => {
  it('shouldExpandDescriptionOnLoad/shouldExpandNotesOnLoad are false for blank/whitespace-only text', () => {
    assert.equal(shouldExpandDescriptionOnLoad(''), false);
    assert.equal(shouldExpandDescriptionOnLoad('   '), false);
    assert.equal(shouldExpandDescriptionOnLoad('has content'), true);
    assert.equal(shouldExpandNotesOnLoad(' \n '), false);
    assert.equal(shouldExpandNotesOnLoad('note'), true);
  });

  it('shouldExpandTrackingSection expands for an in-progress task regardless of other fields', () => {
    assert.equal(shouldExpandTrackingSection({ status: 'in_progress' }), true);
  });

  it('shouldExpandTrackingSection expands when any single tracking signal is present', () => {
    assert.equal(shouldExpandTrackingSection({ priorityNotMedium: true }), true);
    assert.equal(shouldExpandTrackingSection({ hasMaterials: true }), true);
    assert.equal(shouldExpandTrackingSection({ hasLaborOrEstimate: true }), true);
    assert.equal(shouldExpandTrackingSection({ hasHourlyRate: true }), true);
    assert.equal(shouldExpandTrackingSection({ totalCost: 5 }), true);
  });

  it('shouldExpandTrackingSection only honors hasHoursSpent when trackExpenses is also on', () => {
    assert.equal(shouldExpandTrackingSection({ hasHoursSpent: true, trackExpenses: false }), false);
    assert.equal(shouldExpandTrackingSection({ hasHoursSpent: true, trackExpenses: true }), true);
  });

  it('shouldExpandTrackingSection collapses when nothing is set', () => {
    assert.equal(shouldExpandTrackingSection({}), false);
  });

  it('shouldExpandProjectTrackingOnLoad expands when the tracking tree has entries even with a zero rollup', () => {
    const project = makeProject({ status: 'todo', hourlyRate: 0 });
    const tree: ExpenseTreeNode[] = [
      {
        taskId: 't1',
        title: 'Leaf',
        path: [],
        isLeaf: true,
        ownRollup: { hoursSpent: 0, hoursRemaining: 0, materialsTotal: 0, laborCost: 0, totalCost: 0 },
        rollup: { hoursSpent: 0, hoursRemaining: 0, materialsTotal: 0, laborCost: 0, totalCost: 0 },
        children: [],
      },
    ];
    assert.equal(shouldExpandProjectTrackingOnLoad(project, false, tree), true);
  });

  it('shouldExpandProjectTrackingOnLoad collapses for a quiet project with an empty tree', () => {
    const project = makeProject({ status: 'todo', hourlyRate: 0 });
    assert.equal(shouldExpandProjectTrackingOnLoad(project, false, []), false);
  });

  it('shouldExpandProjectTrackingOnLoad expands when the project rollup has a non-zero total cost', () => {
    const project = makeProject({
      status: 'todo',
      trackingRollup: {
        hoursSpent: 0,
        hoursRemaining: 0,
        materialsTotal: 0,
        laborCost: 0,
        totalCost: 12,
        updatedAt: new Date().toISOString(),
      },
    });
    assert.equal(shouldExpandProjectTrackingOnLoad(project, false, []), true);
  });
});
