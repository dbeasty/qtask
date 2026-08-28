import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  insertStepAt,
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

  // DIFF-L1: pressing Enter while editing a persisted step calls
  // insertStepAt (TaskStepsEditor's Enter handler / insertStepAfter) to
  // splice a new empty draft step in immediately after it. Enter also fires
  // onStepCommit, which can trigger a save before the user types anything
  // into the new row — these tests cover that the draft ends up in the
  // right position and survives the resulting save/merge cycle.
  it('Enter on a persisted step inserts the new draft step immediately after it, not at the end', () => {
    const persistedFirst: TaskStep = {
      _id: 'abc123def456abc123def456',
      clientKey: 'server-first',
      text: 'First step',
      done: false,
    };
    const persistedSecond: TaskStep = {
      _id: 'bcd234ef567bcd234ef5678',
      clientKey: 'server-second',
      text: 'Second step',
      done: false,
    };
    const local: TaskStep[] = [persistedFirst, persistedSecond];

    // Enter fires while editing index 0 (the first, persisted step).
    const enterIndex = 0;
    const draft: TaskStep = { _id: 'draft-new', clientKey: 'ck-new', text: '', done: false };
    const afterEnter = insertStepAt(local, enterIndex, draft);

    assert.equal(afterEnter.length, 3);
    assert.equal(afterEnter[0]!.clientKey, 'server-first');
    assert.equal(afterEnter[1]!.clientKey, 'ck-new', 'the new draft must land right after the step Enter was pressed in');
    assert.equal(afterEnter[2]!.clientKey, 'server-second');
  });

  it('a draft step inserted via Enter survives the save/merge round-trip before the user types into it', () => {
    const persistedFirst: TaskStep = {
      _id: 'abc123def456abc123def456',
      clientKey: 'server-first',
      text: 'First step',
      done: false,
    };
    const persistedSecond: TaskStep = {
      _id: 'bcd234ef567bcd234ef5678',
      clientKey: 'server-second',
      text: 'Second step',
      done: false,
    };
    const draft: TaskStep = { _id: 'draft-new', clientKey: 'ck-new', text: '', done: false };
    // Enter was pressed in the first step, inserting the still-empty draft
    // between the two persisted steps — onStepCommit then fires a save
    // before the user has typed anything into it.
    const local: TaskStep[] = [persistedFirst, draft, persistedSecond];

    // stepsForApi strips the empty draft from the save payload, so the
    // server's response (what "saved" becomes) never included it.
    const apiPayload = stepsForApi(local);
    assert.equal(apiPayload.length, 2, 'the empty draft must not be sent to the server');
    const saved: TaskStep[] = apiPayload.map((step) => ({ ...step }));

    const merged = mergeLocalSteps(saved, local);

    assert.equal(merged.length, 3, 'the empty draft must survive the merge, not be dropped');
    assert.equal(merged[0]!.clientKey, 'server-first');
    assert.equal(merged[1]!.clientKey, 'ck-new', 'the draft must stay in its inserted position, not move to the end');
    assert.equal(merged[1]!.text, '', 'the draft must still be empty and editable, not clobbered by the merge');
    assert.equal(merged[2]!.clientKey, 'server-second');
  });
});
