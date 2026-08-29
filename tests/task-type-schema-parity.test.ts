import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Task, Subtask } from '../src/types/task.js';

// RT-L4: the Task/Subtask interfaces had drifted from the Mongoose schema
// (missing sortOrder, staging, and the three training* cost fields) with no
// consumer to catch it at compile time. This file's regression coverage is
// the type check itself (npm run typecheck:tests / tsc), not a runtime
// assertion — a value built with every field the schema actually persists
// must satisfy the Task/Subtask types without a cast. Before the fix, this
// failed to compile with "Object literal may only specify known
// properties" on sortOrder/staging/trainingHourlyRate/etc.
const fullTask = {
  _id: 't1',
  userId: 'u1',
  projectIds: ['p1'],
  title: 'A task',
  steps: [],
  status: 'todo',
  priority: 'medium',
  tags: [],
  percentComplete: 0,
  subtasks: [],
  links: [],
  sortOrder: 0,
  trainingHourlyRate: 25,
  trainingHoursSpent: 1,
  trainingHoursRemaining: 2,
  staging: { conversationId: 'c1', proposalId: 'p1', stagedAt: new Date() },
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies Task;

const fullSubtask = {
  _id: 's1',
  title: 'A subtask',
  steps: [],
  status: 'todo',
  priority: 'medium',
  tags: [],
  percentComplete: 0,
  trainingHourlyRate: 25,
  trainingHoursSpent: 1,
  trainingHoursRemaining: 2,
  subtasks: [],
  links: [],
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies Subtask;

describe('Task/Subtask types match the Mongoose schema fields', () => {
  it('accepts every field the schema persists (see the type-level satisfies checks above)', () => {
    assert.equal(fullTask.sortOrder, 0);
    assert.equal(fullSubtask.trainingHoursSpent, 1);
  });
});
