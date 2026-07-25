import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractCreateProjectName,
  isCreateProjectQuery,
  resolveProjectCreateScope,
} from '../src/utils/createProjectQuery.ts';

describe('extractCreateProjectName', () => {
  it('extracts root project name', () => {
    assert.equal(extractCreateProjectName('create project Q1 Launch'), 'Q1 Launch');
  });

  it('extracts sub-project name', () => {
    assert.equal(extractCreateProjectName('create sub-project Engine work'), 'Engine work');
  });
});

describe('resolveProjectCreateScope', () => {
  it('uses active project as parent for sub-project requests', () => {
    assert.deepEqual(resolveProjectCreateScope('create sub-project Engine work', 'abc123'), {
      parentId: 'abc123',
      isSubProject: true,
    });
  });

  it('uses root scope for normal project requests', () => {
    assert.deepEqual(resolveProjectCreateScope('create project Q1 Launch', 'abc123'), {
      parentId: null,
      isSubProject: false,
    });
  });
});

describe('isCreateProjectQuery', () => {
  it('matches create project phrasing', () => {
    assert.equal(isCreateProjectQuery('create project Q1 Launch'), true);
    assert.equal(isCreateProjectQuery('create sub-project Engine work'), true);
  });

  it('does not match create task phrasing', () => {
    assert.equal(isCreateProjectQuery('create task Buy groceries'), false);
  });

  it('does not match compound project + sub-project or tasks phrasing', () => {
    assert.equal(isCreateProjectQuery('Create project Boat and sub-project Engine work'), false);
    assert.equal(
      isCreateProjectQuery('Create project Garden and add tasks: Plan layout, Buy soil, Plant herbs'),
      false
    );
  });
});
