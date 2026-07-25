import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCreateTaskQuery, extractCreateTaskTitle } from '../src/utils/createTaskQuery.ts';

describe('extractCreateTaskTitle', () => {
  it('extracts title after add a task to', () => {
    assert.equal(
      extractCreateTaskTitle('Add a task to Advertise on Local Facebook'),
      'Advertise on Local Facebook'
    );
  });

  it('extracts title after create task colon', () => {
    assert.equal(extractCreateTaskTitle('create task: Buy groceries'), 'Buy groceries');
  });

  it('extracts quoted title', () => {
    assert.equal(extractCreateTaskTitle('add task "Fix login bug"'), 'Fix login bug');
  });

  it('returns null when no create prefix', () => {
    assert.equal(extractCreateTaskTitle('Advertise on Local Facebook'), null);
  });
});

describe('isCreateTaskQuery', () => {
  it('matches single create-task phrasing', () => {
    assert.equal(isCreateTaskQuery('Add a task to Advertise on Local Facebook'), true);
    assert.equal(isCreateTaskQuery('add task to wash the car'), true);
    assert.equal(isCreateTaskQuery('create task: Buy groceries'), true);
    assert.equal(isCreateTaskQuery('make a new task Plan launch'), true);
  });

  it('does not match how-to phrasing', () => {
    assert.equal(isCreateTaskQuery('how do I add a task'), false);
    assert.equal(isCreateTaskQuery('what is a task'), false);
  });

  it('does not match multi-create phrasing', () => {
    assert.equal(isCreateTaskQuery('Add tasks: A, B, and C'), false);
  });

  it('still matches titles containing "and"', () => {
    assert.equal(
      isCreateTaskQuery('Add a task to Advertise on Orcas Buy and Sell Facebook'),
      true
    );
  });

  it('does not match list-projects phrasing', () => {
    assert.equal(isCreateTaskQuery('list all projects'), false);
  });

  it('does not match unrelated queries', () => {
    assert.equal(isCreateTaskQuery('create a project'), false);
    assert.equal(isCreateTaskQuery(''), false);
  });
});
