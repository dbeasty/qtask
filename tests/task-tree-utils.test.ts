import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ancestorKeys,
  buildSubtaskPath,
  canMoveUp,
  collectAttachTargets,
  collectProjectAttachTargets,
  countNestedSubtasks,
  findPathBySubtaskId,
  findSubtaskByPath,
  getMoveUpAction,
  getSiblingContext,
  isDescendantPath,
  isInvalidAttachTarget,
  nodeKey,
} from '../client/src/utils/taskTree.ts';
import type { Subtask, Task } from '../client/src/types.ts';

function sub(id: string, subtasks: Subtask[] = [], title = id): Subtask {
  return {
    _id: id,
    title,
    status: 'todo',
    priority: 'medium',
    percentComplete: 0,
    subtasks,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    _id: 'root',
    userId: 'u1',
    projectIds: [],
    title: 'Root',
    status: 'todo',
    priority: 'medium',
    tags: [],
    percentComplete: 0,
    subtasks: [],
    ...overrides,
  } as Task;
}

describe('taskTree', () => {
  it('nodeKey combines taskId and path, or is just the taskId at the root', () => {
    assert.equal(nodeKey('t1', []), 't1');
    assert.equal(nodeKey('t1', ['a', 'b']), 't1:a/b');
  });

  it('buildSubtaskPath appends the new id to the parent path', () => {
    assert.deepEqual(buildSubtaskPath(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(buildSubtaskPath([], 'a'), ['a']);
  });

  it('isDescendantPath is true for the ancestor itself and any path under it', () => {
    assert.equal(isDescendantPath(['a'], ['a']), true);
    assert.equal(isDescendantPath(['a'], ['a', 'b']), true);
    assert.equal(isDescendantPath(['a'], ['a', 'b', 'c']), true);
  });

  it('isDescendantPath is false for a sibling or a shorter/unrelated path', () => {
    assert.equal(isDescendantPath(['a'], ['b']), false);
    assert.equal(isDescendantPath(['a', 'b'], ['a']), false);
    assert.equal(isDescendantPath([], ['a']), true, 'every path is a descendant of the root');
  });

  it('findSubtaskByPath walks nested subtasks and returns null on a missing id', () => {
    const tree = [sub('a', [sub('b', [sub('c')])])];
    assert.equal(findSubtaskByPath(tree, ['a', 'b', 'c'])?._id, 'c');
    assert.equal(findSubtaskByPath(tree, ['a', 'x']), null);
    assert.equal(findSubtaskByPath(tree, []), null);
  });

  it('findPathBySubtaskId locates a deeply nested id and returns null if absent', () => {
    const tree = [sub('a', [sub('b', [sub('c')])]), sub('x')];
    assert.deepEqual(findPathBySubtaskId(tree, 'c'), ['a', 'b', 'c']);
    assert.deepEqual(findPathBySubtaskId(tree, 'x'), ['x']);
    assert.equal(findPathBySubtaskId(tree, 'missing'), null);
  });

  it('getSiblingContext resolves the parent list, index, and parentPath for a nested node', () => {
    const t = task({ subtasks: [sub('a', [sub('b'), sub('c')])] });
    const ctx = getSiblingContext(t, ['a', 'c']);
    assert.ok(ctx);
    assert.deepEqual(ctx!.parentPath, ['a']);
    assert.equal(ctx!.index, 1);
    assert.equal(ctx!.siblings.length, 2);
  });

  it('getSiblingContext returns null for the root path or an unresolvable path', () => {
    const t = task({ subtasks: [sub('a')] });
    assert.equal(getSiblingContext(t, []), null);
    assert.equal(getSiblingContext(t, ['missing']), null);
  });

  it('getMoveUpAction reorders within siblings when not already first', () => {
    const t = task({ subtasks: [sub('a'), sub('b')] });
    const action = getMoveUpAction(t, ['b']);
    assert.deepEqual(action, { kind: 'reorder', parentPath: [], index: 0 });
  });

  it('getMoveUpAction promotes a first-level, first-position subtask to a top-level task', () => {
    const t = task({ subtasks: [sub('a')] });
    assert.deepEqual(getMoveUpAction(t, ['a']), { kind: 'promote' });
  });

  it('getMoveUpAction outdents a nested first-position subtask to its grandparent level', () => {
    const t = task({ subtasks: [sub('a', [sub('b')]), sub('sibling-of-a')] });
    const action = getMoveUpAction(t, ['a', 'b']);
    assert.deepEqual(action, { kind: 'outdent', toParentPath: [], index: 0 });
  });

  it('canMoveUp mirrors getMoveUpAction returning non-null', () => {
    const t = task({ subtasks: [sub('a'), sub('b')] });
    assert.equal(canMoveUp(t, ['b']), true);
    assert.equal(canMoveUp(t, []), false);
  });

  it('isInvalidAttachTarget refuses attaching a node into itself or its own descendant', () => {
    assert.equal(isInvalidAttachTarget(['a'], ['a']), true);
    assert.equal(isInvalidAttachTarget(['a'], ['a', 'b']), true);
    assert.equal(isInvalidAttachTarget(['a'], ['b']), false);
  });

  it('collectAttachTargets excludes the dragged node and its descendants, includes everything else', () => {
    const t = task({
      _id: 'root',
      title: 'Root',
      subtasks: [sub('a', [sub('a1')]), sub('b')],
    });
    const targets = collectAttachTargets(t, ['a']);
    const paths = targets.map((tgt) => tgt.parentPath.join('/'));
    assert.ok(paths.includes(''), 'the task root itself must be a valid target');
    assert.ok(paths.includes('b'));
    assert.ok(!paths.includes('a'), 'the dragged node itself must be excluded');
    assert.ok(!paths.includes('a/a1'), "the dragged node's own descendant must be excluded");
  });

  it('collectProjectAttachTargets covers every task except the excluded one, including nested subtasks', () => {
    const tasks = [
      task({ _id: 't1', title: 'Task 1', subtasks: [sub('s1')] }),
      task({ _id: 't2', title: 'Task 2' }),
    ];
    const targets = collectProjectAttachTargets(tasks, 't2');
    const taskIds = targets.map((t) => t.targetTaskId);
    assert.ok(taskIds.includes('t1'));
    assert.ok(!taskIds.includes('t2'), 'the excluded task must not appear as a target');
    assert.ok(targets.some((t) => t.targetTaskId === 't1' && t.parentPath.join('/') === 's1'));
  });

  it('countNestedSubtasks counts every descendant, not just direct children', () => {
    const tree = [sub('a', [sub('b', [sub('c')]), sub('d')]), sub('e')];
    assert.equal(countNestedSubtasks(tree), 5);
    assert.equal(countNestedSubtasks([]), 0);
  });

  it('ancestorKeys returns the root key plus one key per path prefix', () => {
    assert.deepEqual(ancestorKeys('t1', ['a', 'b']), ['t1', 't1:a', 't1:a/b']);
    assert.deepEqual(ancestorKeys('t1', []), ['t1']);
  });
});
