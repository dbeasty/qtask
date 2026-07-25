import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isListProjectTasksQuery } from '../src/utils/listProjectTasksQuery.ts';

describe('isListProjectTasksQuery', () => {
  it('matches list-tasks phrasing for the active project', () => {
    assert.equal(isListProjectTasksQuery('show me the current tasks on this project'), true);
    assert.equal(isListProjectTasksQuery('show me tasks on this project'), true);
    assert.equal(isListProjectTasksQuery('what tasks are in this project'), true);
    assert.equal(isListProjectTasksQuery('list tasks for the current project'), true);
    assert.equal(isListProjectTasksQuery('show me my tasks'), true);
  });

  it('does not match project-only or create phrasing', () => {
    assert.equal(isListProjectTasksQuery('show me the current project'), false);
    assert.equal(isListProjectTasksQuery('list all projects'), false);
    assert.equal(isListProjectTasksQuery('create a task called Wash car'), false);
    assert.equal(isListProjectTasksQuery('summarize this project'), false);
  });
});
