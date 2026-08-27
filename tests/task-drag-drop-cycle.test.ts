import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveDropAction, type DragPayload, type DropTarget } from '../client/src/utils/taskDragDrop.ts';

describe('resolveDropAction subtask cycle prevention', () => {
  it('refuses to drop a subtask before/after its own child (would reparent it into itself)', () => {
    // Tree: task "T" has subtask A (path ['A']), which has child B (path
    // ['A', 'B']). Dragging A and dropping it just before/after its own
    // child B means "insert as a sibling of B" — i.e. as a child of B's
    // parent, which is A itself.
    const drag: DragPayload = { kind: 'subtask', taskId: 'T', path: ['A'] };
    const targetBefore: DropTarget = {
      taskId: 'T',
      path: ['A', 'B'],
      zone: 'before',
      siblingIndex: 0,
      parentPath: ['A'],
      childCount: 1,
    };
    const targetAfter: DropTarget = { ...targetBefore, zone: 'after' };

    assert.equal(resolveDropAction(drag, targetBefore), null, 'dropping before its own child must be rejected');
    assert.equal(resolveDropAction(drag, targetAfter), null, 'dropping after its own child must be rejected');
  });

  it('refuses to drop a subtask before/after a grandchild too', () => {
    // A -> B -> C. Dragging A and dropping next to C (whose parent is B,
    // a descendant of A) would still create a cycle.
    const drag: DragPayload = { kind: 'subtask', taskId: 'T', path: ['A'] };
    const target: DropTarget = {
      taskId: 'T',
      path: ['A', 'B', 'C'],
      zone: 'after',
      siblingIndex: 0,
      parentPath: ['A', 'B'],
      childCount: 1,
    };

    assert.equal(resolveDropAction(drag, target), null);
  });

  it('still allows dropping a subtask before/after an unrelated sibling', () => {
    // A and D are both children of the same task root — a normal reorder.
    const drag: DragPayload = { kind: 'subtask', taskId: 'T', path: ['A'] };
    const target: DropTarget = {
      taskId: 'T',
      path: ['D'],
      zone: 'after',
      siblingIndex: 1,
      parentPath: [],
      childCount: 2,
    };

    const action = resolveDropAction(drag, target);
    assert.ok(action);
    assert.equal(action?.kind, 'move-subtask');
  });
});
