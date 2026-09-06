import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import type { TaskFormValues } from '../client/src/components/TaskForm.tsx';
import type { TaskDraftScope } from '../client/src/utils/taskDraft.ts';

function installFakeLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

installFakeLocalStorage();

function emptyValues(projectName = ''): TaskFormValues {
  return {
    title: '',
    description: '',
    steps: [],
    status: 'todo',
    priority: 'medium',
    projectName,
    tags: '',
    percentComplete: 0,
    progressShare: '',
    hoursSpent: '',
    hoursRemaining: '',
    lastProgressField: 'percent',
    laborLines: [],
    materials: [],
    hourlyRate: '',
  };
}

const draftModule = await import('../client/src/utils/taskDraft.ts');
const {
  applyTaskDraft,
  clearTaskDraft,
  flushTaskDraft,
  hasTaskDraftContent,
  readTaskDraft,
  saveTaskDraft,
  taskDraftScopesEqual,
} = draftModule;

describe('task create drafts', () => {
  beforeEach(() => {
    clearTaskDraft();
  });

  after(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('treats an untouched form as empty, including its pre-filled project name', () => {
    assert.equal(hasTaskDraftContent(emptyValues('Roof rebuild')), false);
    assert.equal(hasTaskDraftContent({ ...emptyValues(), title: 'Order joists' }), true);
    assert.equal(hasTaskDraftContent({ ...emptyValues(), description: 'notes' }), true);
    assert.equal(hasTaskDraftContent({ ...emptyValues(), priority: 'high' }), true);
    assert.equal(
      hasTaskDraftContent({
        ...emptyValues(),
        steps: [{ text: '  ', done: false }],
      }),
      false,
      'a blank step is not work worth keeping'
    );
  });

  it('round-trips an unsaved task through storage', () => {
    const scope = { kind: 'task', projectId: 'p1' } as const;
    saveTaskDraft(scope, {
      ...emptyValues('Roof rebuild'),
      title: 'Order joists',
      description: 'from the yard',
      tags: 'materials, urgent',
      priority: 'high',
      steps: [
        { text: 'Measure span', done: true },
        { text: '', done: false },
      ],
    });
    flushTaskDraft();

    const draft = readTaskDraft();
    assert.ok(draft);
    assert.ok(taskDraftScopesEqual(draft.scope, scope));
    assert.equal(draft.values.title, 'Order joists');
    assert.equal(draft.values.description, 'from the yard');
    assert.equal(draft.values.tags, 'materials, urgent');
    assert.equal(draft.values.priority, 'high');
    assert.deepEqual(
      draft.values.steps,
      [{ text: 'Measure span', done: true }],
      'blank steps are dropped'
    );
  });

  it('restores into form values without reusing server ids for the steps', () => {
    const scope: TaskDraftScope = { kind: 'subtask', taskId: 't1', path: ['s1'] };
    saveTaskDraft(scope, { ...emptyValues(), title: 'Cut rafters', steps: [{ text: 'Sharpen saw', done: false }] });
    flushTaskDraft();

    const draft = readTaskDraft();
    assert.ok(draft);
    const values = applyTaskDraft(emptyValues('Roof rebuild'), draft);
    assert.equal(values.title, 'Cut rafters');
    assert.equal(values.projectName, 'Roof rebuild', 'the live project name wins over a stored empty one');
    assert.equal(values.steps.length, 1);
    assert.equal(values.steps[0].text, 'Sharpen saw');
    assert.match(values.steps[0]._id ?? '', /^draft-/, 'restored steps must be created fresh on submit');
    assert.ok(values.steps[0].clientKey, 'restored steps need a React list key');
  });

  it('emptying a form clears its own draft but leaves another scope alone', () => {
    const subtaskScope: TaskDraftScope = { kind: 'subtask', taskId: 't1', path: [] };
    saveTaskDraft(subtaskScope, { ...emptyValues(), title: 'Cut rafters' });
    flushTaskDraft();

    // Opening an untouched "new task" form must not wipe the pending subtask.
    saveTaskDraft({ kind: 'task', projectId: 'p1' }, emptyValues('Roof rebuild'));
    flushTaskDraft();
    assert.equal(readTaskDraft()?.values.title, 'Cut rafters');

    saveTaskDraft(subtaskScope, emptyValues());
    flushTaskDraft();
    assert.equal(readTaskDraft(), null);
  });

  it('ignores a draft left behind long ago', () => {
    const now = Date.now();
    saveTaskDraft({ kind: 'task', projectId: 'p1' }, { ...emptyValues(), title: 'Order joists' }, 300, now);
    flushTaskDraft();

    assert.ok(readTaskDraft(now + 60_000));
    assert.equal(readTaskDraft(now + 8 * 24 * 60 * 60 * 1000), null);
  });

  it('scopes a subtask draft to its exact parent path', () => {
    assert.equal(
      taskDraftScopesEqual({ kind: 'subtask', taskId: 't1', path: ['a'] }, { kind: 'subtask', taskId: 't1', path: ['a'] }),
      true
    );
    assert.equal(
      taskDraftScopesEqual({ kind: 'subtask', taskId: 't1', path: ['a'] }, { kind: 'subtask', taskId: 't1', path: ['b'] }),
      false
    );
    assert.equal(
      taskDraftScopesEqual({ kind: 'subtask', taskId: 't1', path: [] }, { kind: 'task', projectId: 't1' }),
      false
    );
  });
});
