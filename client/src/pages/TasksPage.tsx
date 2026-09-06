import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addSubtask,
  attachTaskAsSubtask,
  createProject,
  createTask,
  deleteSubtask,
  deleteTask,
  duplicateTask,
  listAllTasks,
  listProjects,
  moveSubtask,
  moveTaskToProject,
  promoteSubtask,
  reorderProjectTask,
  shareTaskToProject,
  unlinkTaskFromProject,
  updateProject,
  updateSubtask,
  updateTask,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { getUserPreferences } from '../auth/storage';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  emptyFormValues,
  parseOptionalNumber,
  parseTagsInput,
  TaskForm,
  type TaskFormValues,
} from '../components/TaskForm';
import { materialsForApi } from '../components/TaskMaterialsEditor';
import { laborLinesForApi, laborLinesFromTask } from '../components/TaskLaborEditor';
import { stepsForApi, stepsFromTask } from '../components/TaskStepsEditor';
import { ProjectToolbar } from '../components/ProjectToolbar';
import { TaskListPanel } from '../components/TaskListPanel';
import { TaskActivitySection } from '../components/TaskActivitySection';
import { TaskCommentsSection } from '../components/TaskCommentsSection';
import { type Selection } from '../components/TaskHierarchyTree';
import type { MaterialLine, Project, Subtask, Task, UpdateTaskInput } from '../types';
import { toggleTaskDone } from '../utils/taskDoneToggle';
import { buildExpenseTree, computeTaskCostRollup } from '../utils/costRollup';
import {
  getDefaultProject,
  groupTasksByProject,
  projectIdToName,
  resolveProjectId,
  taskBelongsToProject,
  taskProjectIds,
} from '../utils/project';
import { buildProjectTree, flattenProjectTree } from '../utils/projectTree';
import { TaskProjectDialog } from '../components/TaskProjectDialog';
import {
  findPathBySubtaskId,
  findSubtaskByPath,
  getMoveUpAction,
} from '../utils/taskTree';
import { mergeAppSessionStateDebounced } from '../utils/appSessionState';
import {
  applyTaskDraft,
  clearTaskDraft,
  flushTaskDraft,
  hasTaskDraftContent,
  readTaskDraft,
  saveTaskDraft,
  taskDraftScopesEqual,
  type TaskDraftScope,
} from '../utils/taskDraft';

interface TasksPageProps {
  suggestedProjectName?: string;
  /** Bumped when another view (e.g. agent) mutates tasks; triggers refetch without remounting. */
  externalRefreshKey?: number;
  activeProjectId: string | null;
  onActiveProjectChange: (projectId: string | null) => void;
  onNeedProject?: () => void;
  pendingSelection?: Selection | null;
  onPendingSelectionApplied?: () => void;
  pendingCreateForProjectId?: string | null;
  onPendingCreateApplied?: () => void;
  restoredSelection?: Selection | null;
  restoredTaskListExpanded?: boolean;
  onSessionRestoreConsumed?: () => void;
  /** When true (major deploy read-only), all task/project edits are disabled in UI. */
  editsDisabled?: boolean;
}

type PendingConfirm =
  | {
      kind: 'delete-item';
      label: string;
      keepChildren: boolean;
      hasChildren: boolean;
    }
  | {
      kind: 'discard-draft';
      /** 'task' or 'subtask' — what the abandoned create form was building. */
      label: string;
      proceed: () => void;
    };

interface DetailItem {
  title: string;
  description?: string;
  status: string;
  priority: string;
  percentComplete: number;
  subtasks: Subtask[];
}

function getDetailItem(task: Task, selection: Selection): DetailItem {
  if (selection.kind === 'task') {
    return {
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      percentComplete: task.percentComplete,
      subtasks: task.subtasks,
    };
  }

  const subtask = findSubtaskByPath(task.subtasks, selection.path);
  if (!subtask) {
    return {
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      percentComplete: task.percentComplete,
      subtasks: task.subtasks,
    };
  }

  return {
    title: subtask.title,
    description: subtask.description,
    status: subtask.status,
    priority: subtask.priority,
    percentComplete: subtask.percentComplete,
    subtasks: subtask.subtasks,
  };
}

function buildBreadcrumb(task: Task, selection: Selection): Array<{ label: string; selection: Selection }> {
  if (selection.kind === 'task') {
    return [];
  }

  const ancestorPath = selection.path.slice(0, -1);
  const crumbs: Array<{ label: string; selection: Selection }> = [
    { label: task.title, selection: { kind: 'task', taskId: task._id } },
  ];

  let current = task.subtasks;
  const path: string[] = [];

  for (const id of ancestorPath) {
    const subtask = current.find((item) => item._id === id);
    if (!subtask) break;
    path.push(id);
    crumbs.push({
      label: subtask.title,
      selection: { kind: 'subtask', taskId: task._id, path: [...path] },
    });
    current = subtask.subtasks;
  }

  return crumbs;
}

function formatOptionalHours(value?: number): string {
  return value !== undefined && value !== null ? String(value) : '';
}

function formatOptionalRate(value?: number): string {
  return value !== undefined && value !== null ? String(value) : '';
}

function materialsFromTask(materials?: MaterialLine[]): MaterialLine[] {
  return (materials ?? []).map((line) => ({
    ...line,
    clientKey: line.clientKey ?? (line._id ? `server-${line._id}` : undefined),
  }));
}

function taskToFormValues(task: Task, projects: Project[]): TaskFormValues {
  return {
    title: task.title,
    description: task.description ?? '',
    steps: stepsFromTask(task.steps),
    status: task.status,
    priority: task.priority,
    projectName: projectIdToName(taskProjectIds(task)[0] ?? '', projects),
    tags: task.tags.join(', '),
    percentComplete: task.percentComplete,
    progressShare: '',
    hoursSpent: formatOptionalHours(task.hoursSpent),
    hoursRemaining: formatOptionalHours(task.hoursRemaining),
    lastProgressField: task.lastProgressField ?? 'percent',
    laborLines: laborLinesFromTask(task.laborLines, task.hoursSpent),
    materials: materialsFromTask(task.materials),
    hourlyRate: formatOptionalRate(task.hourlyRate),
  };
}

function subtaskToFormValues(subtask: Subtask): TaskFormValues {
  return {
    title: subtask.title,
    description: subtask.description ?? '',
    steps: stepsFromTask(subtask.steps),
    status: subtask.status,
    priority: subtask.priority,
    projectName: '',
    tags: '',
    percentComplete: subtask.percentComplete,
    progressShare: subtask.progressShare !== undefined ? String(subtask.progressShare) : '',
    hoursSpent: formatOptionalHours(subtask.hoursSpent),
    hoursRemaining: formatOptionalHours(subtask.hoursRemaining),
    lastProgressField: subtask.lastProgressField ?? 'percent',
    laborLines: laborLinesFromTask(subtask.laborLines, subtask.hoursSpent),
    materials: materialsFromTask(subtask.materials),
    hourlyRate: formatOptionalRate(subtask.hourlyRate),
  };
}

function buildExpensePatch(values: TaskFormValues): Pick<
  UpdateTaskInput,
  'materials' | 'laborLines' | 'hourlyRate'
> {
  const hourlyRate = parseOptionalNumber(values.hourlyRate);
  return {
    materials: materialsForApi(values.materials),
    laborLines: laborLinesForApi(values.laborLines),
    hourlyRate: hourlyRate ?? null,
  };
}

function buildProgressPatch(values: TaskFormValues): Pick<
  UpdateTaskInput,
  'percentComplete' | 'hoursSpent' | 'hoursRemaining' | 'lastProgressField' | 'progressShare'
> {
  const spent = parseOptionalNumber(values.hoursSpent);
  const remaining = parseOptionalNumber(values.hoursRemaining);
  const share = parseOptionalNumber(values.progressShare);

  return {
    percentComplete: values.status === 'done' ? 100 : values.percentComplete,
    hoursSpent: spent ?? null,
    hoursRemaining: remaining ?? null,
    lastProgressField: values.lastProgressField,
    progressShare: share ?? null,
  };
}

function buildTaskUpdatePatch(
  values: TaskFormValues,
  projectId?: string
): UpdateTaskInput {
  const patch: UpdateTaskInput = {
    title: values.title,
    description: values.description || undefined,
    steps: stepsForApi(values.steps),
    status: values.status,
    priority: values.priority,
    tags: parseTagsInput(values.tags),
    ...buildProgressPatch(values),
    ...buildExpensePatch(values),
  };
  if (projectId) {
    patch.projectId = projectId;
  }
  return patch;
}

function subtaskParentPath(selection: Selection): string[] {
  return selection.kind === 'subtask' ? selection.path : [];
}

export function TasksPage({
  suggestedProjectName = '',
  externalRefreshKey = 0,
  activeProjectId,
  onActiveProjectChange,
  onNeedProject,
  pendingSelection = null,
  onPendingSelectionApplied,
  pendingCreateForProjectId = null,
  onPendingCreateApplied,
  restoredSelection,
  restoredTaskListExpanded,
  onSessionRestoreConsumed,
  editsDisabled = false,
}: TasksPageProps) {
  const { user, updatePreferences, updateProfile } = useAuth();
  const preferences = getUserPreferences(user);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [creatingTaskForProjectId, setCreatingTaskForProjectId] = useState<string | null>(null);
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [taskListExpanded, setTaskListExpanded] = useState(
    restoredTaskListExpanded ?? true
  );
  const sessionRestoreAppliedRef = useRef(false);
  const [projectDialogTaskId, setProjectDialogTaskId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const lastExternalRefreshKey = useRef(externalRefreshKey);

  // A task/subtask being created only exists in the form until submit, so it is
  // mirrored into a local draft while it is edited and restored when the form
  // is reopened. draftScopeRef is non-null exactly while a create form is open.
  const draftScopeRef = useRef<TaskDraftScope | null>(null);
  const draftValuesRef = useRef<TaskFormValues | null>(null);
  const draftRestoreAppliedRef = useRef(false);

  const handleDraftValuesChange = useCallback((values: TaskFormValues) => {
    const scope = draftScopeRef.current;
    if (!scope) return;
    draftValuesRef.current = values;
    saveTaskDraft(scope, values);
  }, []);

  const discardDraft = useCallback(() => {
    draftScopeRef.current = null;
    draftValuesRef.current = null;
    clearTaskDraft();
  }, []);

  /**
   * Runs `proceed` unless the open create form holds unsaved work, in which
   * case the user is asked whether to discard it first.
   */
  const confirmLeaveDraft = useCallback(
    (proceed: () => void) => {
      const scope = draftScopeRef.current;
      const values = draftValuesRef.current;
      if (!scope || !values || !hasTaskDraftContent(values)) {
        discardDraft();
        proceed();
        return;
      }
      setPendingConfirm({
        kind: 'discard-draft',
        label: scope.kind === 'subtask' ? 'subtask' : 'task',
        proceed,
      });
    },
    [discardDraft]
  );

  // Commit a debounced draft write before the tab goes away or the page unmounts.
  useEffect(() => {
    const flush = () => flushTaskDraft();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      flushTaskDraft();
    };
  }, []);

  useEffect(() => {
    mergeAppSessionStateDebounced({
      tasks: { selection, taskListExpanded },
    });
  }, [selection, taskListExpanded]);

  useEffect(() => {
    if (restoredTaskListExpanded === undefined) return;
    setTaskListExpanded(restoredTaskListExpanded);
  }, [restoredTaskListExpanded]);

  useEffect(() => {
    if (creatingTaskForProjectId || addingSubtask) {
      setTaskListExpanded(true);
    }
  }, [creatingTaskForProjectId, addingSubtask]);

  // Seeded once when a create form opens (from a stored draft when there is
  // one) rather than derived per render, so TaskForm does not resync the
  // fields out from under the user while they type.
  const [newTaskFormValues, setNewTaskFormValues] = useState<TaskFormValues>(() =>
    emptyFormValues()
  );
  const [newSubtaskFormValues, setNewSubtaskFormValues] = useState<TaskFormValues>(() =>
    emptyFormValues()
  );

  const seedFromDraft = useCallback((scope: TaskDraftScope, base: TaskFormValues): TaskFormValues => {
    const draft = readTaskDraft();
    return draft && taskDraftScopesEqual(draft.scope, scope) ? applyTaskDraft(base, draft) : base;
  }, []);

  const openTaskCreateForm = useCallback(
    (projectId: string) => {
      const scope: TaskDraftScope = { kind: 'task', projectId };
      const seeded = seedFromDraft(scope, emptyFormValues(projectIdToName(projectId, projects)));
      draftScopeRef.current = scope;
      draftValuesRef.current = seeded;
      setNewTaskFormValues(seeded);
      setCreatingTaskForProjectId(projectId);
      setAddingSubtask(false);
      setActionError(null);
    },
    [projects, seedFromDraft]
  );

  const openSubtaskCreateForm = useCallback(
    (forSelection: Selection) => {
      const scope: TaskDraftScope = {
        kind: 'subtask',
        taskId: forSelection.taskId,
        path: subtaskParentPath(forSelection),
      };
      const seeded = seedFromDraft(scope, emptyFormValues());
      draftScopeRef.current = scope;
      draftValuesRef.current = seeded;
      setNewSubtaskFormValues(seeded);
      setAddingSubtask(true);
      setCreatingTaskForProjectId(null);
      setActionError(null);
    },
    [seedFromDraft]
  );

  const closeCreateForms = useCallback(() => {
    discardDraft();
    setCreatingTaskForProjectId(null);
    setAddingSubtask(false);
    setActionError(null);
  }, [discardDraft]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [allTasks, projectResponse] = await Promise.all([listAllTasks(), listProjects()]);
      setTasks(allTasks);
      setProjects(projectResponse.projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (externalRefreshKey === lastExternalRefreshKey.current) return;
    lastExternalRefreshKey.current = externalRefreshKey;
    refresh();
  }, [externalRefreshKey, refresh]);

  const refreshProjects = useCallback(() => {
    void listProjects()
      .then(({ projects: nextProjects }) => setProjects(nextProjects))
      .catch(() => {});
  }, []);

  const applyTaskUpdate = useCallback(
    (updatedTask: Task) => {
      setTasks((current) => current.map((task) => (task._id === updatedTask._id ? updatedTask : task)));
      // Task/subtask status and percentComplete changes roll up into project
      // status server-side (see projectService.recalculateProjectAndAncestors),
      // so the locally-held project list needs to be re-synced here too.
      refreshProjects();
    },
    [refreshProjects]
  );

  const resetHierarchyModes = useCallback(() => {
    discardDraft();
    setAddingSubtask(false);
    setActionError(null);
  }, [discardDraft]);

  const resolveAndRefreshProjects = useCallback(async (projectName: string) => {
    const projectId = await resolveProjectId(projectName, projects, createProject);
    if (projectName.trim() && projectId && !projects.some((project) => project._id === projectId)) {
      const { projects: nextProjects } = await listProjects();
      setProjects(nextProjects);
    }
    return projectId;
  }, [projects]);

  const handleCreateTask = async (values: TaskFormValues, forProjectId: string) => {
    setSaving(true);
    setActionError(null);
    try {
      const { task } = await createTask({
        title: values.title,
        description: values.description || undefined,
        steps: stepsForApi(values.steps),
        status: values.status,
        priority: values.priority,
        projectId: forProjectId,
        tags: parseTagsInput(values.tags),
      });
      setTasks((current) => [task, ...current]);
      discardDraft();
      setSelection({ kind: 'task', taskId: task._id });
      onActiveProjectChange(forProjectId);
      setCreatingTaskForProjectId(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSaving(false);
    }
  };

  const handleAddSubtask = async (values: TaskFormValues) => {
    if (!selection || !selectedTask) return;

    setSaving(true);
    setActionError(null);
    try {
      const { task } = await addSubtask(
        selectedTask._id,
        {
          title: values.title,
          description: values.description || undefined,
          steps: stepsForApi(values.steps),
          status: values.status,
          priority: values.priority,
        },
        subtaskParentPath(selection)
      );
      discardDraft();
      applyTaskUpdate(task);
      setAddingSubtask(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add subtask');
    } finally {
      setSaving(false);
    }
  };

  const handleMoveSubtask = async (
    taskId: string,
    fromPath: string[],
    toParentPath: string[],
    index?: number
  ) => {
    setSaving(true);
    setActionError(null);
    try {
      const { task } = await moveSubtask(taskId, { fromPath, toParentPath, index });
      applyTaskUpdate(task);
      if (selection?.kind === 'subtask' && selection.taskId === taskId) {
        const selectedId = selection.path[selection.path.length - 1]!;
        const newPath = findPathBySubtaskId(task.subtasks, selectedId);
        setSelection(newPath ? { kind: 'subtask', taskId, path: newPath } : { kind: 'task', taskId });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to move subtask');
    } finally {
      setSaving(false);
    }
  };

  const handlePromoteSubtask = async (taskId: string, path: string[]) => {
    setSaving(true);
    setActionError(null);
    try {
      const { task, promotedTask } = await promoteSubtask(taskId, path);
      setTasks((current) => {
        const updated = current.map((item) => (item._id === task._id ? task : item));
        const withoutPromoted = updated.filter((item) => item._id !== promotedTask._id);
        return [promotedTask, ...withoutPromoted];
      });
      setSelection({ kind: 'task', taskId: promotedTask._id });
      const promotedProjectId = taskProjectIds(promotedTask)[0];
      if (promotedProjectId) {
        onActiveProjectChange(promotedProjectId);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to move subtask to project');
    } finally {
      setSaving(false);
    }
  };

  const handleAttachTask = async (
    sourceTaskId: string,
    targetTaskId: string,
    parentPath: string[],
    index?: number
  ) => {
    setSaving(true);
    setActionError(null);
    try {
      const { targetTask, removedTaskId, subtaskId } = await attachTaskAsSubtask(targetTaskId, {
        sourceTaskId,
        parentPath,
        index,
      });
      setTasks((current) =>
        current
          .filter((item) => item._id !== removedTaskId)
          .map((item) => (item._id === targetTaskId ? targetTask : item))
      );
      setSelection({
        kind: 'subtask',
        taskId: targetTaskId,
        path: [...parentPath, subtaskId],
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to attach task');
    } finally {
      setSaving(false);
    }
  };

  const handleMoveUp = async (taskId: string, path: string[]) => {
    const task = tasks.find((item) => item._id === taskId);
    if (!task) return;

    const action = getMoveUpAction(task, path);
    if (!action) return;

    if (action.kind === 'promote') {
      await handlePromoteSubtask(taskId, path);
      return;
    }

    if (action.kind === 'reorder') {
      await handleMoveSubtask(taskId, path, action.parentPath, action.index);
      return;
    }

    await handleMoveSubtask(taskId, path, action.toParentPath, action.index);
  };

  const handleMoveTask = async (taskId: string, index: number) => {
    if (!resolvedActiveProjectId) return;

    setSaving(true);
    setActionError(null);
    try {
      const { tasks: updatedTasks } = await reorderProjectTask(resolvedActiveProjectId, taskId, index);
      setTasks(updatedTasks);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reorder task');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleDone = async (taskId: string, path: string[], done: boolean) => {
    setSaving(true);
    setActionError(null);
    try {
      const task = await toggleTaskDone(taskId, path, done, taskCanEdit);
      applyTaskUpdate(task);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setSaving(false);
    }
  };

  const selectedTask = useMemo(
    () => (selection ? tasks.find((task) => task._id === selection.taskId) ?? null : null),
    [selection, tasks]
  );

  const performDelete = async (keepChildren = false): Promise<boolean> => {
    if (!selection || !selectedTask) return false;

    setSaving(true);
    setActionError(null);
    try {
      if (selection.kind === 'task') {
        const result = await deleteTask(selectedTask._id, { keepChildren });
        if (keepChildren) {
          const allTasks = await listAllTasks();
          setTasks(allTasks);
          const promotedId =
            result && 'promotedTasks' in result && result.promotedTasks?.[0]?._id;
          setSelection(
            promotedId
              ? { kind: 'task', taskId: promotedId }
              : allTasks.length > 0
                ? { kind: 'task', taskId: allTasks[0]._id }
                : null
          );
        } else {
          const remaining = tasks.filter((task) => task._id !== selectedTask._id);
          setTasks(remaining);
          setSelection(remaining.length > 0 ? { kind: 'task', taskId: remaining[0]._id } : null);
        }
      } else {
        const result = await deleteSubtask(selectedTask._id, selection.path, { keepChildren });
        if (keepChildren && result && 'task' in result && result.task) {
          applyTaskUpdate(result.task);
          setSelection({ kind: 'task', taskId: selectedTask._id });
        } else {
          const allTasks = await listAllTasks();
          setTasks(allTasks);
          setSelection({ kind: 'task', taskId: selectedTask._id });
        }
      }
      resetHierarchyModes();
      refreshProjects();
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (keepChildren = false): Promise<boolean> => {
    if (!selection || !selectedTask) return false;

    if (preferences.skipConfirmations) {
      return performDelete(keepChildren);
    }

    const hasChildren =
      selection.kind === 'task'
        ? selectedTask.subtasks.length > 0
        : (findSubtaskByPath(selectedTask.subtasks, selection.path)?.subtasks.length ?? 0) > 0;
    const label = selection.kind === 'task' ? 'task' : 'subtask';
    setPendingConfirm({ kind: 'delete-item', label, keepChildren, hasChildren });
    return false;
  };

  useEffect(() => {
    // Keep selection within the active project's tasks when the scoped project changes.
    if (!activeProjectId) {
      setSelection(null);
      return;
    }

    if (pendingSelection) {
      if (tasks.length === 0) return;

      const task = tasks.find((item) => item._id === pendingSelection.taskId);
      if (task && taskBelongsToProject(task, activeProjectId)) {
        if (pendingSelection.kind === 'subtask') {
          const subtask = findSubtaskByPath(task.subtasks, pendingSelection.path);
          if (subtask) {
            setSelection(pendingSelection);
            onPendingSelectionApplied?.();
            return;
          }
        } else {
          setSelection(pendingSelection);
          onPendingSelectionApplied?.();
          return;
        }
      }
      onPendingSelectionApplied?.();
    }

    if (!sessionRestoreAppliedRef.current && restoredSelection !== undefined) {
      sessionRestoreAppliedRef.current = true;
      onSessionRestoreConsumed?.();

      if (tasks.length === 0) {
        setSelection(null);
        return;
      }

      if (restoredSelection === null) {
        setSelection(null);
        return;
      }

      const restoredTask = tasks.find((item) => item._id === restoredSelection.taskId);
      if (restoredTask && taskBelongsToProject(restoredTask, activeProjectId)) {
        if (restoredSelection.kind === 'subtask') {
          const subtask = findSubtaskByPath(restoredTask.subtasks, restoredSelection.path);
          if (subtask) {
            setSelection(restoredSelection);
            return;
          }
        } else {
          setSelection(restoredSelection);
          return;
        }
      }
    }

    if (
      !sessionRestoreAppliedRef.current &&
      restoredSelection === undefined &&
      restoredTaskListExpanded !== undefined
    ) {
      sessionRestoreAppliedRef.current = true;
      onSessionRestoreConsumed?.();
    }

    setSelection((current) => {
      if (!current) {
        const first = tasks.find((task) => taskBelongsToProject(task, activeProjectId));
        return first ? { kind: 'task', taskId: first._id } : null;
      }
      const selected = tasks.find((task) => task._id === current.taskId);
      if (!selected || !taskBelongsToProject(selected, activeProjectId)) {
        const first = tasks.find((task) => taskBelongsToProject(task, activeProjectId));
        return first ? { kind: 'task', taskId: first._id } : null;
      }
      if (current.kind === 'subtask' && !findSubtaskByPath(selected.subtasks, current.path)) {
        return { kind: 'task', taskId: selected._id };
      }
      return current;
    });
  }, [
    activeProjectId,
    tasks,
    pendingSelection,
    onPendingSelectionApplied,
    restoredSelection,
    restoredTaskListExpanded,
    onSessionRestoreConsumed,
  ]);

  useEffect(() => {
    if (!pendingCreateForProjectId || loading) return;
    if (pendingCreateForProjectId !== activeProjectId) return;

    openTaskCreateForm(pendingCreateForProjectId);
    setSelection(null);
    setTaskListExpanded(true);
    onPendingCreateApplied?.();
  }, [pendingCreateForProjectId, activeProjectId, loading, onPendingCreateApplied, openTaskCreateForm]);

  const detail = selectedTask && selection ? getDetailItem(selectedTask, selection) : null;
  const breadcrumbs = selectedTask && selection ? buildBreadcrumb(selectedTask, selection) : [];

  const editFormValues = useMemo(() => {
    if (!selectedTask || !selection) return emptyFormValues(suggestedProjectName);
    if (selection.kind === 'task') return taskToFormValues(selectedTask, projects);
    const subtask = findSubtaskByPath(selectedTask.subtasks, selection.path);
    return subtask ? subtaskToFormValues(subtask) : emptyFormValues();
  }, [selectedTask, selection, projects, suggestedProjectName]);

  const selectionKey =
    selection === null
      ? ''
      : `${selection.taskId}:${selection.kind === 'subtask' ? selection.path.join('/') : ''}`;

  const isLeafDetail = detail ? detail.subtasks.length === 0 : false;
  const isParentDetail = detail ? detail.subtasks.length > 0 : false;

  const projectGroups = useMemo(() => groupTasksByProject(tasks, projects), [tasks, projects]);

  const resolvedActiveProjectId = useMemo(() => {
    if (activeProjectId && projects.some((p) => p._id === activeProjectId)) {
      return activeProjectId;
    }
    if (suggestedProjectName.trim()) {
      const matched = projects.find(
        (p) => p.name.toLowerCase() === suggestedProjectName.trim().toLowerCase()
      );
      if (matched) return matched._id;
    }
    return getDefaultProject(projects)?._id ?? projects[0]?._id ?? null;
  }, [activeProjectId, projects, suggestedProjectName]);

  useEffect(() => {
    if (resolvedActiveProjectId && resolvedActiveProjectId !== activeProjectId) {
      onActiveProjectChange(resolvedActiveProjectId);
    }
  }, [resolvedActiveProjectId, activeProjectId, onActiveProjectChange]);

  // Reopen a create form left behind by a view switch, a reload, or a closed
  // tab. Runs once per mount; the draft is cleared on create or discard, so
  // this only fires when there really is unsaved work.
  useEffect(() => {
    if (draftRestoreAppliedRef.current || loading) return;
    if (pendingCreateForProjectId) return;
    if (creatingTaskForProjectId || addingSubtask) {
      draftRestoreAppliedRef.current = true;
      return;
    }

    const draft = readTaskDraft();
    if (!draft) {
      draftRestoreAppliedRef.current = true;
      return;
    }

    if (draft.scope.kind === 'task') {
      if (!resolvedActiveProjectId) return;
      draftRestoreAppliedRef.current = true;
      if (draft.scope.projectId !== resolvedActiveProjectId) return;
      openTaskCreateForm(resolvedActiveProjectId);
      setTaskListExpanded(true);
      return;
    }

    // A subtask draft only makes sense against the parent it was started from.
    if (!selection) return;
    draftRestoreAppliedRef.current = true;
    if (
      taskDraftScopesEqual(draft.scope, {
        kind: 'subtask',
        taskId: selection.taskId,
        path: subtaskParentPath(selection),
      })
    ) {
      openSubtaskCreateForm(selection);
      setTaskListExpanded(true);
    }
  }, [
    loading,
    pendingCreateForProjectId,
    creatingTaskForProjectId,
    addingSubtask,
    resolvedActiveProjectId,
    selection,
    openTaskCreateForm,
    openSubtaskCreateForm,
  ]);

  const editableProjects = useMemo(
    () => flattenProjectTree(buildProjectTree(projects.filter((project) => project.canEdit))),
    [projects]
  );

  const activeProject = useMemo(
    () => projects.find((p) => p._id === resolvedActiveProjectId) ?? null,
    [projects, resolvedActiveProjectId]
  );

  const taskCanEdit = Boolean(activeProject?.canEdit) && !editsDisabled;
  const taskCanUpdateStatus = Boolean(activeProject?.canUpdateStatus) && !editsDisabled;

  const canDeleteTask = useCallback(
    (task: Task) => {
      if (!activeProject || !user) return false;
      if (activeProject.role === 'owner') return true;
      if (activeProject.canDeleteOwnTasks && task.userId === user.id) return true;
      return false;
    },
    [activeProject, user]
  );

  const projectRates = useMemo(
    () => ({
      hourlyRate: activeProject?.hourlyRate,
      userHourlyRate: user?.hourlyRate,
    }),
    [activeProject?.hourlyRate, user?.hourlyRate]
  );

  const childExpenseNodes = useMemo(() => {
    if (!selectedTask || !detail || detail.subtasks.length === 0) return [];
    return buildExpenseTree(selectedTask._id, detail.subtasks, projectRates);
  }, [selectedTask, detail, projectRates]);

  const detailCostRollup = useMemo(() => {
    if (!selectedTask || !selection || !isParentDetail) return undefined;
    if (selection.kind === 'task') {
      return computeTaskCostRollup(selectedTask, projectRates);
    }
    const subtask = findSubtaskByPath(selectedTask.subtasks, selection.path);
    return subtask ? computeTaskCostRollup(subtask, projectRates) : undefined;
  }, [selectedTask, selection, isParentDetail, projectRates]);

  const saveTaskDetail = useCallback(
    async (
      values: TaskFormValues,
      forSelection: Selection,
      forTask: Task
    ): Promise<TaskFormValues> => {
      const statusOnly = !taskCanEdit && taskCanUpdateStatus;

      if (forSelection.kind === 'task') {
        if (statusOnly) {
          const { task } = await updateTask(forTask._id, { status: values.status });
          applyTaskUpdate(task);
          return taskToFormValues(task, projects);
        }
        const projectId = await resolveAndRefreshProjects(values.projectName);
        const { task } = await updateTask(
          forTask._id,
          buildTaskUpdatePatch(values, projectId)
        );
        applyTaskUpdate(task);
        return taskToFormValues(task, projects);
      } else {
        if (statusOnly) {
          const { task } = await updateSubtask(forTask._id, forSelection.path, {
            status: values.status,
          });
          applyTaskUpdate(task);
          const subtask = findSubtaskByPath(task.subtasks, forSelection.path);
          return subtask ? subtaskToFormValues(subtask) : values;
        }
        const { task } = await updateSubtask(forTask._id, forSelection.path, {
          title: values.title,
          description: values.description || undefined,
          steps: stepsForApi(values.steps),
          status: values.status,
          priority: values.priority,
          ...buildProgressPatch(values),
          ...buildExpensePatch(values),
        });
        applyTaskUpdate(task);
        const subtask = findSubtaskByPath(task.subtasks, forSelection.path);
        return subtask ? subtaskToFormValues(subtask) : values;
      }
    },
    [taskCanEdit, taskCanUpdateStatus, applyTaskUpdate, projects, resolveAndRefreshProjects]
  );

  const handleAutoSaveTaskDetail = useCallback(
    (values: TaskFormValues) => {
      if (!selection || !selectedTask) return Promise.resolve();
      return saveTaskDetail(values, selection, selectedTask);
    },
    [selection, selectedTask, saveTaskDetail]
  );

  const taskDetailAutoSave = useMemo(
    () => ({ onSave: handleAutoSaveTaskDetail }),
    [handleAutoSaveTaskDetail]
  );

  const activeProjectGroup = useMemo(
    () => projectGroups.find((group) => group.projectId === resolvedActiveProjectId) ?? null,
    [projectGroups, resolvedActiveProjectId]
  );

  const activeProjectTasks = activeProjectGroup?.tasks ?? [];

  const projectDialogTask = useMemo(
    () => (projectDialogTaskId ? tasks.find((task) => task._id === projectDialogTaskId) ?? null : null),
    [projectDialogTaskId, tasks]
  );

  async function handleConfirmDialog(dontAskAgain: boolean) {
    if (pendingConfirm?.kind !== 'delete-item') return;
    setConfirmBusy(true);
    try {
      if (dontAskAgain && !preferences.skipConfirmations) {
        await updatePreferences({ skipConfirmations: true });
      }
      await performDelete(pendingConfirm.keepChildren);
      setPendingConfirm(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not save preference');
    } finally {
      setConfirmBusy(false);
    }
  }

  const handleSelect = (next: Selection) => {
    confirmLeaveDraft(() => {
      closeCreateForms();
      setSelection(next);
    });
  };

  const handleStartAddTask = (projectId: string) => {
    if (creatingTaskForProjectId === projectId) {
      confirmLeaveDraft(closeCreateForms);
      return;
    }
    confirmLeaveDraft(() => {
      openTaskCreateForm(projectId);
      setSelection(null);
    });
  };

  const hasSelection = Boolean(selection && selectedTask);
  const isAddingTask = creatingTaskForProjectId === resolvedActiveProjectId;
  const addTaskLabel = isAddingTask ? 'Cancel' : '+ Add task';
  const addSubtaskButtonLabel = addingSubtask ? 'Cancel' : '+ Add subtask';
  const addSubtaskLabel = detail ? `Add subtask to "${detail.title}"` : 'Add subtask';

  const handleAddTaskClick = () => {
    if (isAddingTask) {
      confirmLeaveDraft(closeCreateForms);
      return;
    }
    if (resolvedActiveProjectId) {
      handleStartAddTask(resolvedActiveProjectId);
    }
  };

  const handleAddSubtaskClick = () => {
    if (!hasSelection || !selection) return;
    if (addingSubtask) {
      confirmLeaveDraft(closeCreateForms);
      return;
    }
    confirmLeaveDraft(() => openSubtaskCreateForm(selection));
  };

  return (
    <section className="tasks-page">
      {error && <p className="error-banner">{error}</p>}
      {actionError && <p className="error-banner">{actionError}</p>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && !activeProjectId && (
        <div className="tasks-empty-state">
          <p className="muted">Select a project to view its tasks.</p>
          <div className="tasks-empty-state-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => onNeedProject?.()}
              disabled={saving}
            >
              Open projects
            </button>
          </div>
        </div>
      )}

      {projects.length > 0 && activeProjectId && !loading && (
        <>
          <ProjectToolbar
            activeProject={activeProject}
            projects={projects}
            projectCount={projects.length}
            taskCount={activeProjectTasks.length}
            taskListExpanded={taskListExpanded}
            onTaskListExpandedChange={setTaskListExpanded}
            onOpenProjects={() => onNeedProject?.()}
            onSelectProject={(projectId) =>
              confirmLeaveDraft(() => {
                closeCreateForms();
                onActiveProjectChange(projectId);
              })
            }
            listActions={
              <>
                <button
                  type="button"
                  className="primary-button"
                  data-demo-step="add-task"
                  onClick={handleAddTaskClick}
                  disabled={saving || !resolvedActiveProjectId || !taskCanEdit}
                >
                  {addTaskLabel}
                </button>
                {hasSelection && taskCanEdit ? (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleAddSubtaskClick}
                    disabled={saving}
                  >
                    {addSubtaskButtonLabel}
                  </button>
                ) : null}
              </>
            }
          />

          <div className={`tasks-layout${taskListExpanded ? '' : ' tasks-layout-task-list-collapsed'}`}>
            {taskListExpanded && activeProjectGroup && (
              <TaskListPanel
                tasks={activeProjectGroup.tasks}
                selection={selection}
                saving={saving}
                onDelete={handleDelete}
                onSelect={handleSelect}
                canToggleDone={Boolean(taskCanEdit || taskCanUpdateStatus)}
                onToggleDone={handleToggleDone}
                onMoveSubtask={handleMoveSubtask}
                onMoveUp={handleMoveUp}
                onPromoteSubtask={handlePromoteSubtask}
                onMoveTask={handleMoveTask}
                onAttachTask={handleAttachTask}
                canManageProjects={taskCanEdit}
                onOpenProjectDialog={setProjectDialogTaskId}
                canDeleteTask={canDeleteTask}
              />
            )}

            {creatingTaskForProjectId && activeProjectGroup ? (
              <article className="task-detail-panel">
                <h3 className="panel-title">New task</h3>
                <TaskForm
                  mode="create"
                  className="task-detail-form"
                  initialValues={newTaskFormValues}
                  showProjectFields
                  projects={projects}
                  submitLabel="Create task"
                  saving={saving}
                  onValuesChange={handleDraftValuesChange}
                  onSubmit={(values) => handleCreateTask(values, creatingTaskForProjectId)}
                  onCancel={() => confirmLeaveDraft(closeCreateForms)}
                />
              </article>
            ) : addingSubtask && selection ? (
              <article className="task-detail-panel">
                <h3 className="panel-title">{addSubtaskLabel}</h3>
                <TaskForm
                  mode="create"
                  className="task-detail-form"
                  initialValues={newSubtaskFormValues}
                  submitLabel={addSubtaskLabel}
                  saving={saving}
                  onValuesChange={handleDraftValuesChange}
                  onSubmit={handleAddSubtask}
                  onCancel={() => confirmLeaveDraft(closeCreateForms)}
                />
              </article>
            ) : selectedTask && detail && selection ? (
              <article className="task-detail-panel">
                {breadcrumbs.length > 0 && (
                  <nav className="task-breadcrumb" aria-label="Task navigation">
                    {breadcrumbs.map((crumb, index) => (
                      <span key={`${crumb.selection.kind}-${index}`} className="task-breadcrumb-item">
                        {index > 0 && <span className="task-breadcrumb-sep">›</span>}
                        <button
                          type="button"
                          className="task-breadcrumb-link"
                          onClick={() => handleSelect(crumb.selection)}
                        >
                          {crumb.label}
                        </button>
                      </span>
                    ))}
                  </nav>
                )}

                <h3 className="panel-title">Task details</h3>

                <TaskForm
                  key={selectionKey}
                  mode="edit"
                  className="task-detail-form"
                  initialValues={editFormValues}
                  showProjectFields={false}
                  showProgressFields={isLeafDetail || isParentDetail}
                  showProgressShare={selection.kind === 'subtask'}
                  readOnlyProgress={isParentDetail}
                  progressValue={detail.percentComplete}
                  childExpenseNodes={childExpenseNodes}
                  onNavigateToSubtask={(taskId, path) =>
                    handleSelect({ kind: 'subtask', taskId, path })
                  }
                  trackingPreferences={{
                    trackExpenses: preferences.trackExpenses,
                  }}
                  projectRates={projectRates}
                  costRollup={detailCostRollup}
                  userHourlyRate={user?.hourlyRate}
                  projectId={resolvedActiveProjectId ?? undefined}
                  canEditProject={taskCanEdit}
                  onProjectRateChange={async (rate) => {
                    if (!resolvedActiveProjectId) return;
                    const { project } = await updateProject(resolvedActiveProjectId, {
                      hourlyRate: rate,
                    });
                    setProjects((current) =>
                      current.map((item) => (item._id === project._id ? project : item))
                    );
                  }}
                  onUserRateChange={async (rate) => {
                    await updateProfile({ hourlyRate: rate });
                  }}
                  projects={projects}
                  disabled={!taskCanEdit}
                  statusEditable={taskCanUpdateStatus}
                  autoSave={taskDetailAutoSave}
                />

                {user && (
                  <TaskCommentsSection
                    taskId={selection.taskId}
                    subtaskPath={selection.kind === 'subtask' ? selection.path : undefined}
                    currentUserId={user.id}
                    canComment={taskCanUpdateStatus}
                    canModerate={taskCanEdit}
                    refreshKey={externalRefreshKey}
                  />
                )}

                {user && (
                  <TaskActivitySection
                    taskId={selection.taskId}
                    currentUserId={user.id}
                    refreshKey={externalRefreshKey}
                  />
                )}
              </article>
            ) : (
              <article className="task-detail-panel task-detail-panel-empty">
                <p className="muted">Select a task or add one to this project.</p>
              </article>
            )}
          </div>
        </>
      )}

      {projectDialogTask && (
        <TaskProjectDialog
          task={projectDialogTask}
          projects={projects}
          editableProjects={editableProjects}
          currentProjectId={resolvedActiveProjectId}
          saving={saving}
          onClose={() => setProjectDialogTaskId(null)}
          onMove={async (projectId) => {
            setSaving(true);
            setActionError(null);
            try {
              const { task } = await moveTaskToProject(projectDialogTask._id, projectId);
              applyTaskUpdate(task);
              onActiveProjectChange(projectId);
            } catch (err) {
              setActionError(err instanceof Error ? err.message : 'Failed to move task');
            } finally {
              setSaving(false);
            }
          }}
          onShare={async (projectId) => {
            setSaving(true);
            setActionError(null);
            try {
              const { task } = await shareTaskToProject(projectDialogTask._id, projectId);
              applyTaskUpdate(task);
            } catch (err) {
              setActionError(err instanceof Error ? err.message : 'Failed to share task');
            } finally {
              setSaving(false);
            }
          }}
          onDuplicate={async (projectId) => {
            setSaving(true);
            setActionError(null);
            try {
              const { task } = await duplicateTask(projectDialogTask._id, projectId);
              setTasks((current) => [task, ...current]);
              setSelection({ kind: 'task', taskId: task._id });
              onActiveProjectChange(projectId);
            } catch (err) {
              setActionError(err instanceof Error ? err.message : 'Failed to duplicate task');
            } finally {
              setSaving(false);
            }
          }}
          onUnlink={async (projectId) => {
            setSaving(true);
            setActionError(null);
            try {
              const { task } = await unlinkTaskFromProject(projectDialogTask._id, projectId);
              applyTaskUpdate(task);
            } catch (err) {
              setActionError(err instanceof Error ? err.message : 'Failed to unlink task');
            } finally {
              setSaving(false);
            }
          }}
        />
      )}

      {pendingConfirm?.kind === 'discard-draft' && (
        <ConfirmDialog
          title="Unsaved draft"
          message={`This ${pendingConfirm.label} has not been created yet. Discard what you have written, or keep editing and create it.`}
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          showDontAskAgain={false}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const { proceed } = pendingConfirm;
            setPendingConfirm(null);
            discardDraft();
            proceed();
          }}
        />
      )}

      {pendingConfirm?.kind === 'delete-item' && (
        <ConfirmDialog
          title="Delete"
          message={
            pendingConfirm.keepChildren
              ? `Delete this ${pendingConfirm.label}? Its subtasks will be kept.`
              : pendingConfirm.hasChildren
                ? `Delete this ${pendingConfirm.label} and its subtasks? This cannot be undone.`
                : `Delete this ${pendingConfirm.label}? This cannot be undone.`
          }
          confirmLabel="Delete"
          busy={confirmBusy || saving}
          onCancel={() => {
            if (!confirmBusy && !saving) setPendingConfirm(null);
          }}
          onConfirm={(dontAskAgain) => handleConfirmDialog(dontAskAgain)}
        />
      )}
    </section>
  );
}
