import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCurrentProjectQuery } from '../src/utils/currentProjectQuery.ts';

describe('isCurrentProjectQuery', () => {
  it('matches current project phrasing', () => {
    assert.equal(isCurrentProjectQuery('show me the current project'), true);
    assert.equal(isCurrentProjectQuery('what project am I on?'), true);
    assert.equal(isCurrentProjectQuery('show me this project'), true);
    assert.equal(isCurrentProjectQuery('show me the project'), true);
    assert.equal(isCurrentProjectQuery('list current project'), true);
    assert.equal(isCurrentProjectQuery('get me the current project'), true);
  });

  it('does not match task-list phrasing', () => {
    assert.equal(isCurrentProjectQuery('show me the current tasks on this project'), false);
    assert.equal(isCurrentProjectQuery('what tasks are in this project'), false);
  });

  it('does not match list-all phrasing', () => {
    assert.equal(isCurrentProjectQuery('list all projects'), false);
    assert.equal(isCurrentProjectQuery('show me all my projects'), false);
    assert.equal(isCurrentProjectQuery('how many projects do I have?'), false);
  });
});
