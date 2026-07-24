import {
  laborLinesEqualForSave,
  laborLinesForApi,
  laborLinesFromTask,
  mergeLocalLaborLines,
  sumLaborHours,
} from '../client/src/components/TaskLaborEditor.tsx';
import type { LaborLine } from '../client/src/types.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('task labor line helpers', () => {
  it('laborLinesForApi strips empty draft rows', () => {
    const laborLines: LaborLine[] = [
      { _id: 'abc123def456abc123def456', description: 'Setup', hours: 2 },
      { _id: 'draft-1', description: '', hours: 0 },
    ];
    assert.deepEqual(laborLinesForApi(laborLines), [
      { _id: 'abc123def456abc123def456', description: 'Setup', hours: 2 },
    ]);
  });

  it('laborLinesEqualForSave ignores empty draft rows', () => {
    const a: LaborLine[] = [
      { _id: 'abc123def456abc123def456', description: 'Work', hours: 1.5 },
      { description: '', hours: 0 },
    ];
    const b: LaborLine[] = [
      { _id: 'abc123def456abc123def456', description: 'Work', hours: 1.5 },
    ];
    assert.equal(laborLinesEqualForSave(a, b), true);
  });

  it('migrates legacy hoursSpent into a labor line on load', () => {
    const lines = laborLinesFromTask([], 3.5);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.hours, 3.5);
    assert.equal(lines[0]?.description, 'Prior total');
  });

  it('sumLaborHours totals line hours', () => {
    const lines: LaborLine[] = [{ hours: 1.5 }, { hours: 2 }];
    assert.equal(sumLaborHours(lines), 3.5);
  });

  it('mergeLocalLaborLines preserves empty draft rows during sync', () => {
    const saved: LaborLine[] = [
      { _id: 'abc123def456abc123def456', description: 'Setup', hours: 2 },
    ];
    const local: LaborLine[] = [
      {
        _id: 'abc123def456abc123def456',
        clientKey: 'server-setup',
        description: 'Setup',
        hours: 2,
      },
      { _id: 'draft-new', clientKey: 'ck-new', description: '', hours: 0 },
    ];
    const merged = mergeLocalLaborLines(saved, local);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]!._id, 'abc123def456abc123def456');
    assert.equal(merged[1]!.clientKey, 'ck-new');
    assert.equal(merged[1]!.hours, 0);
  });

  it('mergeLocalLaborLines adopts server ids for newly saved labor lines', () => {
    const saved: LaborLine[] = [
      { _id: 'abc123def456abc123def456', description: 'Work', hours: 1.5 },
    ];
    const local: LaborLine[] = [
      { _id: 'draft-new', clientKey: 'ck-new', description: 'Work', hours: 1.5 },
    ];
    const merged = mergeLocalLaborLines(saved, local);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!._id, 'abc123def456abc123def456');
    assert.equal(merged[0]!.clientKey, 'ck-new');
  });
});
