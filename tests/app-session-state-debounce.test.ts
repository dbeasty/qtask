import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

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

describe('mergeAppSessionStateDebounced does not let one channel clobber another', () => {
  before(() => {
    (globalThis as { localStorage: Storage }).localStorage.clear();
  });

  after(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('persists concurrent debounced updates to different top-level fields (agent vs tasks)', async () => {
    const {
      getAppSessionState,
      mergeAppSessionStateDebounced,
      setSessionPersistEnabled,
    } = await import('../client/src/utils/appSessionState.ts');

    setSessionPersistEnabled(true);

    // AgentPage stays mounted behind whichever of TasksPage/ProjectsPage is
    // active, so its own debounced write can land in the same window as
    // the visible page's — these two calls simulate that overlap.
    mergeAppSessionStateDebounced({ agent: { conversationId: 'conv-1' } }, 20);
    mergeAppSessionStateDebounced({ tasks: { selection: { kind: 'task', taskId: 'task-1' } } }, 20);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const state = getAppSessionState();
    assert.equal(state?.agent?.conversationId, 'conv-1', 'the agent-channel update must not be dropped');
    assert.equal(
      state?.tasks?.selection?.kind === 'task' ? state.tasks.selection.taskId : undefined,
      'task-1',
      'the tasks-channel update must not be dropped'
    );
  });
});
