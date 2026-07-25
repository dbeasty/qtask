import type { Selection } from '../components/TaskHierarchyTree';
import type { StartupViewPreference } from '../auth/storage';

export type MainView = 'agent' | 'projects' | 'tasks';

export interface AppSessionState {
  version: 1;
  view: MainView;
  tasks?: {
    selection: Selection | null;
    taskListExpanded?: boolean;
  };
  projects?: {
    listExpanded?: boolean;
  };
  agent?: {
    conversationId?: string;
  };
}

const STORAGE_KEY = 'qtask_app_session_state';
const MAIN_VIEWS: MainView[] = ['agent', 'projects', 'tasks'];

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let skipPersist = true;

export function setSessionPersistEnabled(enabled: boolean): void {
  skipPersist = !enabled;
}

function isMainView(value: unknown): value is MainView {
  return typeof value === 'string' && MAIN_VIEWS.includes(value as MainView);
}

function isSelection(value: unknown): value is Selection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Selection>;
  if (candidate.kind === 'task') {
    return typeof candidate.taskId === 'string' && candidate.taskId.length > 0;
  }
  if (candidate.kind === 'subtask') {
    return (
      typeof candidate.taskId === 'string' &&
      candidate.taskId.length > 0 &&
      Array.isArray(candidate.path) &&
      candidate.path.every((segment) => typeof segment === 'string')
    );
  }
  return false;
}

function normalizeState(raw: unknown): AppSessionState | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<AppSessionState>;
  if (!isMainView(candidate.view)) return null;

  const state: AppSessionState = {
    version: 1,
    view: candidate.view,
  };

  if (candidate.tasks && typeof candidate.tasks === 'object') {
    const tasks = candidate.tasks;
    state.tasks = {
      selection:
        tasks.selection === null
          ? null
          : isSelection(tasks.selection)
            ? tasks.selection
            : null,
      ...(typeof tasks.taskListExpanded === 'boolean'
        ? { taskListExpanded: tasks.taskListExpanded }
        : {}),
    };
  }

  if (candidate.projects && typeof candidate.projects === 'object') {
    const projects = candidate.projects;
    if (typeof projects.listExpanded === 'boolean') {
      state.projects = { listExpanded: projects.listExpanded };
    }
  }

  if (candidate.agent && typeof candidate.agent === 'object') {
    const agent = candidate.agent;
    if (typeof agent.conversationId === 'string' && agent.conversationId.length > 0) {
      state.agent = { conversationId: agent.conversationId };
    }
  }

  return state;
}

export function getAppSessionState(): AppSessionState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeAppSessionState(state: AppSessionState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage failures
  }
}

export function mergeAppSessionState(partial: Partial<Omit<AppSessionState, 'version'>>): void {
  if (skipPersist) return;

  const current = getAppSessionState();
  const view = partial.view ?? current?.view ?? 'projects';
  const next: AppSessionState = {
    version: 1,
    view,
    tasks: partial.tasks !== undefined ? partial.tasks : current?.tasks,
    projects: partial.projects !== undefined ? partial.projects : current?.projects,
    agent: partial.agent !== undefined ? partial.agent : current?.agent,
  };
  writeAppSessionState(next);
}

export function mergeAppSessionStateDebounced(
  partial: Partial<Omit<AppSessionState, 'version'>>,
  delayMs = 300
): void {
  if (skipPersist) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    mergeAppSessionState(partial);
  }, delayMs);
}

export function resolveStartupView(
  pref: StartupViewPreference,
  session: AppSessionState | null
): MainView {
  if (pref === 'agent' || pref === 'projects' || pref === 'tasks') return pref;
  if (pref === 'last' && session?.view) return session.view;
  return 'projects';
}
