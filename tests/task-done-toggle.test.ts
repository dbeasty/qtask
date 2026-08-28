import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTaskDoneTogglePatch } from '../client/src/utils/taskDoneToggle.ts';

describe('buildTaskDoneTogglePatch', () => {
  it('marking done just sets status, without touching percentComplete', () => {
    assert.deepEqual(buildTaskDoneTogglePatch(true, true), { status: 'done' });
    assert.deepEqual(buildTaskDoneTogglePatch(true, false), { status: 'done' });
  });

  it('un-marking done resets percentComplete to 0 when the caller can edit', () => {
    assert.deepEqual(buildTaskDoneTogglePatch(false, true), {
      status: 'todo',
      percentComplete: 0,
      lastProgressField: 'percent',
    });
  });

  it('un-marking done without edit rights (status-only) leaves percentComplete untouched', () => {
    // An executor-only collaborator can flip status but the server rejects
    // any other field in that request, so this must not include
    // percentComplete even though un-completing a task normally resets it.
    assert.deepEqual(buildTaskDoneTogglePatch(false, false), { status: 'todo' });
  });
});
