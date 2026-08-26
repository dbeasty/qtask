import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isProjectRowExpanded } from '../client/src/utils/projectTree.ts';
import type { ProjectTreeNode } from '../client/src/utils/projectTree.ts';

function childNode(id: string): ProjectTreeNode {
  return {
    project: { _id: id } as ProjectTreeNode['project'],
    children: [],
  };
}

describe('isProjectRowExpanded', () => {
  it('is expanded when explicitly in the expanded set', () => {
    const expanded = new Set(['p1']);
    assert.equal(isProjectRowExpanded(expanded, 'p1', [], null), true);
  });

  it('is expanded when a direct child is the current selection', () => {
    const expanded = new Set<string>();
    const children = [childNode('child-1')];
    assert.equal(isProjectRowExpanded(expanded, 'p1', children, 'child-1'), true);
  });

  it('is NOT force-expanded just because the row itself is selected', () => {
    // Regression test: a prior version OR'd in `project._id === selectionId`,
    // which permanently forced the selected row open — clicking its own
    // chevron removed it from `expanded` but the row stayed open, making
    // the collapse control on the most-used row look broken.
    const expanded = new Set<string>();
    assert.equal(isProjectRowExpanded(expanded, 'p1', [], 'p1'), false);
  });

  it('respects a manual collapse of the selected row (removed from expanded set)', () => {
    // The selected row was previously expanded by the user, then they
    // clicked the chevron to collapse it (removing it from `expanded`).
    // It must actually collapse, not stay open.
    const expanded = new Set<string>(); // already removed by the toggle
    assert.equal(isProjectRowExpanded(expanded, 'p1', [], 'p1'), false);
  });

  it('is not expanded when neither condition holds', () => {
    const expanded = new Set(['other-project']);
    const children = [childNode('child-1')];
    assert.equal(isProjectRowExpanded(expanded, 'p1', children, 'unrelated-selection'), false);
  });
});
