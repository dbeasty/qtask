import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTaskExpenseTree,
  computeFormCostSummary,
  computeTaskCostRollup,
  deriveHoursProgressPercent,
  filterNonZeroExpenseNodes,
  formatMoney,
} from '../client/src/utils/costRollup.ts';
import type { ExpenseTreeNode, Task } from '../client/src/types.ts';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    _id: 't1',
    userId: 'u1',
    projectIds: [],
    title: 'Task',
    status: 'todo',
    priority: 'medium',
    tags: [],
    percentComplete: 0,
    subtasks: [],
    ...overrides,
  } as Task;
}

describe('costRollup', () => {
  it('computeTaskCostRollup sums labor and materials for a leaf task', () => {
    const task = makeTask({
      hoursSpent: 2,
      hoursRemaining: 1,
      hourlyRate: 50,
      materials: [{ _id: 'm1', description: 'Lumber', quantity: 2, unitPrice: 10 }],
    });
    const rollup = computeTaskCostRollup(task, {});
    assert.equal(rollup.hoursSpent, 2);
    assert.equal(rollup.hoursRemaining, 1);
    assert.equal(rollup.materialsTotal, 20);
    assert.equal(rollup.laborCost, 150); // (2+1) * 50
    assert.equal(rollup.totalCost, 170);
  });

  it('computeTaskCostRollup falls back to project/user hourly rate when the task has none', () => {
    const task = makeTask({ hoursSpent: 1, hoursRemaining: 1 });
    const rollup = computeTaskCostRollup(task, { hourlyRate: 20 });
    assert.equal(rollup.laborCost, 40);

    const rollupUserRate = computeTaskCostRollup(task, { userHourlyRate: 30 });
    assert.equal(rollupUserRate.laborCost, 60);

    // Task's own rate wins over both project defaults.
    const withOwnRate = computeTaskCostRollup(makeTask({ hoursSpent: 1, hoursRemaining: 1, hourlyRate: 5 }), {
      hourlyRate: 20,
      userHourlyRate: 30,
    });
    assert.equal(withOwnRate.laborCost, 10);
  });

  it('computeTaskCostRollup recursively includes nested subtasks', () => {
    const task = makeTask({
      hoursSpent: 1,
      hourlyRate: 10,
      subtasks: [
        {
          _id: 's1',
          title: 'Sub 1',
          status: 'todo',
          priority: 'medium',
          percentComplete: 0,
          subtasks: [],
          hoursSpent: 2,
          hourlyRate: 10,
        },
        {
          _id: 's2',
          title: 'Sub 2',
          status: 'todo',
          priority: 'medium',
          percentComplete: 0,
          hoursSpent: 3,
          hourlyRate: 10,
          subtasks: [
            {
              _id: 's2a',
              title: 'Sub 2a',
              status: 'todo',
              priority: 'medium',
              percentComplete: 0,
              subtasks: [],
              hoursSpent: 4,
              hourlyRate: 10,
            },
          ],
        },
      ],
    });
    const rollup = computeTaskCostRollup(task, {});
    // own(1) + sub1(2) + sub2(3) + sub2a(4) = 10 hours * $10 = $100
    assert.equal(rollup.hoursSpent, 10);
    assert.equal(rollup.laborCost, 100);
  });

  it('ignores negative or non-finite inputs, treating them as zero', () => {
    const task = makeTask({ hoursSpent: -5, hoursRemaining: NaN, hourlyRate: 10 });
    const rollup = computeTaskCostRollup(task, {});
    assert.equal(rollup.hoursSpent, 0);
    assert.equal(rollup.hoursRemaining, 0);
    assert.equal(rollup.laborCost, 0);
  });

  it('buildTaskExpenseTree marks a childless task as a leaf with a single node', () => {
    const task = makeTask({ hoursSpent: 1, hourlyRate: 10 });
    const tree = buildTaskExpenseTree(task, {});
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.isLeaf, true);
    assert.equal(tree[0]!.children.length, 0);
    assert.equal(tree[0]!.rollup.laborCost, 10);
  });

  it('buildTaskExpenseTree builds one node per subtask, each with its own rollup', () => {
    const task = makeTask({
      subtasks: [
        {
          _id: 's1',
          title: 'Sub 1',
          status: 'todo',
          priority: 'medium',
          percentComplete: 0,
          subtasks: [],
          hoursSpent: 1,
          hourlyRate: 10,
        },
      ],
    });
    const tree = buildTaskExpenseTree(task, {});
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.isLeaf, true);
    assert.deepEqual(tree[0]!.path, ['s1']);
    assert.equal(tree[0]!.ownRollup.laborCost, 10);
  });

  it('computeFormCostSummary sums labor line hours over the plain hoursSpent field when present', () => {
    const summary = computeFormCostSummary(
      {
        hoursSpent: '99', // must be ignored in favor of laborLines
        hoursRemaining: '2',
        hourlyRate: '10',
        materials: [],
        laborLines: [
          { _id: 'l1', hours: 1 },
          { _id: 'l2', hours: 3 },
        ],
      },
      {}
    );
    assert.equal(summary.hoursSpent, 4);
    assert.equal(summary.laborCost, 60); // (4 + 2) * 10
  });

  it('computeFormCostSummary falls back to hoursSpent when there are no labor lines', () => {
    const summary = computeFormCostSummary(
      { hoursSpent: '5', hoursRemaining: '', hourlyRate: '10', materials: [] },
      {}
    );
    assert.equal(summary.hoursSpent, 5);
    assert.equal(summary.hoursRemaining, 0);
  });

  it('deriveHoursProgressPercent is 100 for a done task regardless of hours', () => {
    assert.equal(deriveHoursProgressPercent(0, 0, 'done'), 100);
  });

  it('deriveHoursProgressPercent is 0 when no hours are logged at all', () => {
    assert.equal(deriveHoursProgressPercent(0, 0), 0);
  });

  it('deriveHoursProgressPercent computes and clamps the spent/total ratio', () => {
    assert.equal(deriveHoursProgressPercent(1, 3), 25);
    assert.equal(deriveHoursProgressPercent(10, 0), 100);
  });

  it('formatMoney always shows two decimal places', () => {
    assert.equal(formatMoney(5), '5.00');
    assert.equal(formatMoney(5.1), '5.10');
    assert.equal(formatMoney(5.006), '5.01');
  });

  it('filterNonZeroExpenseNodes drops zero-cost leaves but keeps a zero-cost parent with non-zero children', () => {
    const zeroLeaf: ExpenseTreeNode = {
      taskId: 't1',
      title: 'Zero leaf',
      path: ['a'],
      isLeaf: true,
      ownRollup: { hoursSpent: 0, hoursRemaining: 0, materialsTotal: 0, laborCost: 0, totalCost: 0 },
      rollup: { hoursSpent: 0, hoursRemaining: 0, materialsTotal: 0, laborCost: 0, totalCost: 0 },
      children: [],
    };
    const nonZeroLeaf: ExpenseTreeNode = {
      ...zeroLeaf,
      taskId: 't1',
      title: 'Non-zero leaf',
      path: ['b'],
      rollup: { ...zeroLeaf.rollup, totalCost: 42 },
    };
    const zeroParentWithNonZeroChild: ExpenseTreeNode = {
      ...zeroLeaf,
      title: 'Zero parent',
      path: ['c'],
      isLeaf: false,
      children: [nonZeroLeaf],
    };

    const filtered = filterNonZeroExpenseNodes([zeroLeaf, nonZeroLeaf, zeroParentWithNonZeroChild]);
    const titles = filtered.map((n) => n.title);
    assert.ok(!titles.includes('Zero leaf'), 'a zero-cost leaf with no children must be dropped');
    assert.ok(titles.includes('Non-zero leaf'));
    assert.ok(
      titles.includes('Zero parent'),
      'a zero-cost node must still survive if it has a non-zero descendant'
    );
  });
});
