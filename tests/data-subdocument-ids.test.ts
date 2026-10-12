/**
 * presetSubdocumentIds: which objects in a write are sub-documents that get an `_id` up front
 * (so two stores receiving the write store the same id), and - as important - which are not.
 * Adding an `_id` to a Mixed value or an `_id: false` sub-document would change the data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { presetSubdocumentIds } from '../src/data/subdocumentIds.ts';
import type { Doc } from '../src/data/types.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
await import('../src/models/index.ts');

const tasks = mongoose.models.Task!.schema;
const users = mongoose.models.User!.schema;
const hasId = (value: unknown) => typeof (value as Doc)._id === 'string' && /^[0-9a-f]{24}$/.test((value as Doc)._id as string);

describe('presetSubdocumentIds', () => {
  it('gives pushed sub-documents an id, one element or $each', () => {
    const one = presetSubdocumentIds(tasks, { $push: { steps: { text: 'a' } } }) as { $push: { steps: Doc } };
    assert.ok(hasId(one.$push.steps));
    const many = presetSubdocumentIds(tasks, { $push: { steps: { $each: [{ text: 'a' }, { text: 'b' }], $position: 0 } } }) as {
      $push: { steps: { $each: Doc[]; $position: number } };
    };
    assert.ok(many.$push.steps.$each.every(hasId));
    assert.equal(many.$push.steps.$position, 0, 'modifiers are kept');
    assert.notEqual(many.$push.steps.$each[0]!._id, many.$push.steps.$each[1]!._id);
  });

  it('reaches sub-documents nested in sub-documents, and $set of a list or one element', () => {
    const nested = presetSubdocumentIds(tasks, { $push: { subtasks: { title: 's', steps: [{ text: 'x' }] } } }) as { $push: { subtasks: Doc } };
    assert.ok(hasId(nested.$push.subtasks));
    assert.ok(hasId((nested.$push.subtasks.steps as Doc[])[0]));
    const list = presetSubdocumentIds(tasks, { $set: { 'subtasks.0.steps': [{ text: 'y' }] } }) as { $set: Record<string, Doc[]> };
    assert.ok(hasId(list.$set['subtasks.0.steps']![0]));
    const element = presetSubdocumentIds(tasks, { $set: { 'steps.2': { text: 'z' } } }) as { $set: Record<string, Doc> };
    assert.ok(hasId(element.$set['steps.2']));
  });

  it('keeps an id the caller already gave', () => {
    const out = presetSubdocumentIds(tasks, { $push: { steps: { _id: '0123456789abcdef01234567', text: 'a' } } }) as { $push: { steps: Doc } };
    assert.equal(out.$push.steps._id, '0123456789abcdef01234567');
  });

  it('leaves alone what is not a sub-document with ids', () => {
    // identityProviders is a list of `_id: false` sub-documents.
    const noIds = presetSubdocumentIds(users, { $push: { identityProviders: { provider: 'google', providerUserId: '1' } } }) as {
      $push: { identityProviders: Doc };
    };
    assert.equal('_id' in noIds.$push.identityProviders, false);
    // Arrays of scalars, and plain fields.
    const scalars = presetSubdocumentIds(tasks, { $push: { tags: 'x' }, $set: { title: 't' } });
    assert.deepEqual(scalars, { $push: { tags: 'x' }, $set: { title: 't' } });
    // Operators that cannot introduce sub-documents.
    const other = { $inc: { percentComplete: 1 }, $pull: { steps: { text: 'a' } }, $unset: { description: '' } };
    assert.deepEqual(presetSubdocumentIds(tasks, other), other);
  });

  it('fills a replacement document but not its root, and never edits the caller\'s object', () => {
    const input = { userId: 'u', title: 't', steps: [{ text: 'a' }] };
    const out = presetSubdocumentIds(tasks, input) as typeof input & { _id?: string };
    assert.equal(out._id, undefined, 'the document id is the store\'s to assign');
    assert.ok(hasId(out.steps[0]));
    assert.equal('_id' in input.steps[0]!, false, 'the caller\'s update was modified');
  });
});
