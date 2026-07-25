import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isListProjectsQuery } from '../src/utils/listProjectsQuery.ts';

describe('isListProjectsQuery', () => {
  it('matches list-all phrasing', () => {
    assert.equal(isListProjectsQuery('what are the projects'), true);
    assert.equal(isListProjectsQuery('list all projects'), true);
    assert.equal(isListProjectsQuery('show me all my projects'), true);
    assert.equal(isListProjectsQuery('how many projects do I have?'), true);
    assert.equal(isListProjectsQuery('what projects do I have'), true);
  });

  it('does not match current-project phrasing', () => {
    assert.equal(isListProjectsQuery('show me the current project'), false);
    assert.equal(isListProjectsQuery('what project am I on?'), false);
    assert.equal(isListProjectsQuery('show me this project'), false);
  });

  it('does not match unrelated queries', () => {
    assert.equal(isListProjectsQuery('create a task'), false);
    assert.equal(isListProjectsQuery(''), false);
  });
});
