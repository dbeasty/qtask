import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mergeLocalSteps,
  stepsEqualForSave,
  stepsForApi,
  stepsFromTask,
} from '../client/src/components/TaskStepsEditor.tsx';
import type { TaskStep } from '../client/src/types.ts';

describe('task steps merge and save helpers', () => {
  it('stepsForApi strips empty draft rows', () => {
    const steps: TaskStep[] = [
      { _id: 'abc123def456abc123def456', clientKey: 'server-1', text: 'Done step', done: false },
      { _id: 'draft-1', clientKey: 'ck-1', text: '', done: false },
    ];
    assert.deepEqual(stepsForApi(steps), [
      { _id: 'abc123def456abc123def456', text: 'Done step', done: false },
    ]);
  });

  it('stepsEqualForSave ignores empty draft rows', () => {
    const a: TaskStep[] = [
      { _id: 'abc123def456abc123def456', clientKey: 's1', text: 'Step one', done: false },
      { clientKey: 'ck-empty', text: '', done: false },
    ];
    const b: TaskStep[] = [
      { _id: 'abc123def456abc123def456', clientKey: 's1', text: 'Step one', done: false },
    ];
    assert.equal(stepsEqualForSave(a, b), true);
  });

  it('mergeLocalSteps preserves local order and adopts server ids', () => {
    const saved: TaskStep[] = [
      { _id: 'abc123def456abc123def456', text: 'First', done: false },
      { _id: 'bcd234ef567bcd234ef5678', text: 'Second', done: true },
    ];
    const local: TaskStep[] = [
      { _id: 'abc123def456abc123def456', clientKey: 'server-first', text: 'First', done: false },
      { _id: 'draft-new', clientKey: 'ck-new', text: 'Second', done: true },
      { clientKey: 'ck-empty', text: '', done: false },
    ];
    const merged = mergeLocalSteps(saved, local);
    assert.equal(merged.length, 3);
    assert.equal(merged[0]!._id, 'abc123def456abc123def456');
    assert.equal(merged[0]!.clientKey, 'server-first');
    assert.equal(merged[1]!._id, 'bcd234ef567bcd234ef5678');
    assert.equal(merged[1]!.clientKey, 'ck-new');
    assert.equal(merged[2]!.text, '');
    assert.equal(merged[2]!.clientKey, 'ck-empty');
  });

  it('stepsFromTask assigns stable clientKey from server id', () => {
    const steps = stepsFromTask([
      { _id: 'abc123def456abc123def456', text: 'Persisted', done: false },
    ]);
    assert.equal(steps[0]!.clientKey, 'server-abc123def456abc123def456');
  });

  it('mergeLocalSteps keeps local text for persisted steps during in-flight save', () => {
    const saved: TaskStep[] = [
      { _id: 'abc123def456abc123def456', text: 'Old server text', done: false },
    ];
    const local: TaskStep[] = [
      {
        _id: 'abc123def456abc123def456',
        clientKey: 'server-first',
        text: 'Edited locally',
        done: false,
      },
    ];
    const merged = mergeLocalSteps(saved, local);
    assert.equal(merged[0]!.text, 'Edited locally');
  });
});
