import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolArgs, validateToolProposal } from '../src/agent/tools.js';

describe('normalizeToolArgs create_task subtasks', () => {
  it('promotes description-only subtasks to title', () => {
    const normalized = normalizeToolArgs('create_task', {
      title: 'Test the Boar',
      subtasks: [{ description: 'Add fresh fuel' }, { description: 'Add stabilizer' }],
    });

    assert.deepEqual(normalized.subtasks, [
      { title: 'Add fresh fuel' },
      { title: 'Add stabilizer' },
    ]);

    const validation = validateToolProposal('create_task', {
      title: 'Test the Boar',
      subtasks: [{ description: 'Add fresh fuel' }, { description: 'Add stabilizer' }],
    });
    assert.equal(validation.success, true);
    if (validation.success) {
      assert.deepEqual(validation.data.subtasks, [
        { title: 'Add fresh fuel' },
        { title: 'Add stabilizer' },
      ]);
    }
  });

  it('parses string-encoded subtasks and normalizes nested items', () => {
    const normalized = normalizeToolArgs('create_task', {
      title: 'Parent',
      subtasks: JSON.stringify([
        {
          description: 'Outer step',
          subtasks: [{ name: 'Inner step' }],
        },
      ]),
    });

    assert.deepEqual(normalized.subtasks, [
      {
        title: 'Outer step',
        subtasks: [{ title: 'Inner step' }],
      },
    ]);

    const validation = validateToolProposal('create_task', {
      title: 'Parent',
      subtasks: JSON.stringify([
        {
          description: 'Outer step',
          subtasks: [{ name: 'Inner step' }],
        },
      ]),
    });
    assert.equal(validation.success, true);
  });

  it('promotes task_name and taskName aliases on subtasks', () => {
    const normalized = normalizeToolArgs('create_task', {
      title: 'Parent',
      subtasks: [{ task_name: 'From snake' }, { taskName: 'From camel' }],
    });

    assert.deepEqual(normalized.subtasks, [{ title: 'From snake' }, { title: 'From camel' }]);
  });

  it('leaves valid titled subtasks unchanged', () => {
    const normalized = normalizeToolArgs('create_task', {
      title: 'Parent',
      subtasks: [{ title: 'Keep me', description: 'Details' }],
    });

    assert.deepEqual(normalized.subtasks, [{ title: 'Keep me', description: 'Details' }]);
  });
});

describe('validateToolProposal id validation', () => {
  const validId = '507f1f77bcf86cd799439011';

  it('rejects fabricated short taskId like "12345"', () => {
    const validation = validateToolProposal('update_task', {
      taskId: '12345',
      title: 'Test the Boat',
    });
    assert.equal(validation.success, false);
    if (!validation.success) {
      assert.match(validation.error, /taskId/);
      assert.match(validation.error, /find_tasks/);
    }
  });

  it('rejects 16-char hex taskId that is not a full ObjectId', () => {
    const validation = validateToolProposal('update_task', {
      taskId: '0123456789abcdef',
      title: 'Test the Boat',
    });
    assert.equal(validation.success, false);
  });

  it('accepts a real 24-char hex taskId', () => {
    const validation = validateToolProposal('update_task', {
      taskId: validId,
      title: 'Test the Boat',
    });
    assert.equal(validation.success, true);
  });

  it('rejects invented linkedTaskId on add_task_link', () => {
    const validation = validateToolProposal('add_task_link', {
      taskId: validId,
      linkedTaskId: 'task-2',
      type: 'related',
    });
    assert.equal(validation.success, false);
  });

  it('rejects invented projectId on create_task but allows omitting it', () => {
    const invalid = validateToolProposal('create_task', {
      title: 'New task',
      projectId: 'my-project',
    });
    assert.equal(invalid.success, false);

    const valid = validateToolProposal('create_task', { title: 'New task' });
    assert.equal(valid.success, true);
  });
});
