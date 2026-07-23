import { materialsEqualForSave, materialsForApi } from '../client/src/components/TaskMaterialsEditor.tsx';
import type { MaterialLine } from '../client/src/types.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('task materials merge helpers', () => {
  it('materialsForApi strips empty draft rows', () => {
    const materials: MaterialLine[] = [
      { _id: 'abc123def456abc123def456', description: 'Lumber', quantity: 3, unitPrice: 12.5 },
      { _id: 'draft-1', description: '', quantity: 0, unitPrice: 0 },
    ];
    assert.deepEqual(materialsForApi(materials), [
      { _id: 'abc123def456abc123def456', description: 'Lumber', quantity: 3, unitPrice: 12.5 },
    ]);
  });

  it('materialsEqualForSave ignores empty draft rows', () => {
    const a: MaterialLine[] = [
      { _id: 'abc123def456abc123def456', description: 'Wire', quantity: 1, unitPrice: 4 },
      { description: '', quantity: 0, unitPrice: 0 },
    ];
    const b: MaterialLine[] = [
      { _id: 'abc123def456abc123def456', description: 'Wire', quantity: 1, unitPrice: 4 },
    ];
    assert.equal(materialsEqualForSave(a, b), true);
  });
});
