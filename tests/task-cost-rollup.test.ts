import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildExpenseTree,
  computeLeafCost,
  computeTaskCostRollup,
  weightedCostRollup,
} from '../src/utils/taskCostRollup.js';

describe('task cost rollup', () => {
  it('computes leaf cost from materials and labor', () => {
    const cost = computeLeafCost(
      {
        hoursSpent: 2,
        hoursRemaining: 3,
        materials: [{ _id: '1', description: 'Paint', quantity: 2, unitPrice: 10 }],
      },
      { hourlyRate: 50 }
    );

    assert.equal(cost.materialsTotal, 20);
    assert.equal(cost.laborCost, 250);
    assert.equal(cost.totalCost, 270);
  });

  it('uses task hourly rate override over project default', () => {
    const cost = computeLeafCost(
      {
        hoursSpent: 2,
        hoursRemaining: 0,
        hourlyRate: 80,
      },
      { hourlyRate: 50 }
    );

    assert.equal(cost.laborCost, 160);
  });

  it('falls back to user hourly rate when task and project rates are unset', () => {
    const cost = computeLeafCost(
      {
        hoursSpent: 2,
        hoursRemaining: 0,
      },
      { hourlyRate: 50, userHourlyRate: 40 }
    );

    assert.equal(cost.laborCost, 100);
  });

  it('includes parent own expenses plus child rollups', () => {
    const rollup = computeTaskCostRollup(
      {
        hoursSpent: 1,
        hoursRemaining: 0,
        materials: [{ _id: '0', description: 'Parent', quantity: 1, unitPrice: 20 }],
        subtasks: [
          {
            hoursSpent: 1,
            hoursRemaining: 1,
            materials: [{ _id: '1', description: 'A', quantity: 1, unitPrice: 5 }],
          },
          {
            hoursSpent: 2,
            hoursRemaining: 0,
            materials: [{ _id: '2', description: 'B', quantity: 1, unitPrice: 10 }],
          },
        ],
      },
      { hourlyRate: 10 }
    );

    assert.equal(rollup.materialsTotal, 35);
    assert.equal(rollup.laborCost, 50);
    assert.equal(rollup.totalCost, 85);
  });

  it('weights parent project rollup by progressShare', () => {
    const rollup = weightedCostRollup([
      { progressShare: 25, rollup: { hoursSpent: 0, hoursRemaining: 0, materialsTotal: 0, laborCost: 0, totalCost: 100 } },
      { progressShare: 75, rollup: { hoursSpent: 0, hoursRemaining: 0, materialsTotal: 0, laborCost: 0, totalCost: 200 } },
    ]);

    assert.equal(rollup.totalCost, 175);
  });

  it('builds hierarchical expense tree with string paths', () => {
    const tree = buildExpenseTree(
      'task-1',
      [
        {
          _id: 'sub-1',
          title: 'Phase 1',
          subtasks: [
            {
              _id: 'sub-1a',
              title: 'Leaf work',
              hoursSpent: 2,
              hoursRemaining: 0,
              materials: [],
            },
          ],
        },
      ] as Record<string, unknown>[],
      { hourlyRate: 10 }
    );

    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.path.join('/'), 'sub-1');
    assert.equal(tree[0]?.children[0]?.path.join('/'), 'sub-1/sub-1a');
    assert.equal(tree[0]?.children[0]?.isLeaf, true);
  });
});
