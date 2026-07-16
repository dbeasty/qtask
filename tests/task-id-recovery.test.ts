import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFindTasksRecoveryArgs,
  isValidObjectId,
  needsUpdateTaskIdRecovery,
  wrapFindTasksRecoveryResult,
} from '../src/agent/taskIdRecovery.js';

describe('taskIdRecovery helpers', () => {
  it('recognizes valid and invalid ObjectIds', () => {
    assert.equal(isValidObjectId('507f1f77bcf86cd799439011'), true);
    assert.equal(isValidObjectId('1234567890abcdef'), false);
    assert.equal(isValidObjectId('12345'), false);
  });

  it('detects update_task id validation failures for recovery', () => {
    assert.equal(
      needsUpdateTaskIdRecovery(
        'update_task',
        'Validation failed: taskId: must be a real 24-character hex id'
      ),
      true
    );
    assert.equal(needsUpdateTaskIdRecovery('update_task', 'Task not found'), true);
    assert.equal(
      needsUpdateTaskIdRecovery('update_task', 'Cast to ObjectId failed for value'),
      true
    );
    assert.equal(
      needsUpdateTaskIdRecovery(
        'update_task',
        'taskId: Cast to ObjectId failed for value "12345"'
      ),
      true
    );
    assert.equal(needsUpdateTaskIdRecovery('create_task', 'Task not found'), false);
    assert.equal(needsUpdateTaskIdRecovery('get_task', 'Task not found'), false);
  });

  it('builds find_tasks query from latest user message first', () => {
    const args = buildFindTasksRecoveryArgs(
      { taskId: '12345', title: 'Test the Boat' },
      [
        { role: 'user', content: 'Rename Test the Boar to Test the Boat' },
        { role: 'assistant', content: 'Updating…' },
      ]
    );
    assert.equal(args.query, 'Rename Test the Boar to Test the Boat');
    assert.equal(args.limit, 10);
  });

  it('falls back to proposed title when no user message exists', () => {
    const args = buildFindTasksRecoveryArgs({ title: 'Test the Boat' }, [
      { role: 'assistant', content: 'hello' },
    ]);
    assert.equal(args.query, 'Test the Boat');
  });

  it('omits query when neither user message nor title is available', () => {
    const args = buildFindTasksRecoveryArgs({ taskId: '12345' }, []);
    assert.equal(args.query, undefined);
    assert.equal(args.limit, 10);
  });

  it('wraps find_tasks results with recovery guidance', () => {
    const wrapped = wrapFindTasksRecoveryResult('{"count":1,"tasks":[]}');
    assert.match(wrapped, /count.:1/);
    assert.match(wrapped, /RECOVERY:/);
    assert.match(wrapped, /find_tasks/);
    assert.match(wrapped, /approve/);
  });
});
