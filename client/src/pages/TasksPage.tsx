import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addSubtask,
  attachTaskAsSubtask,
  createProject,
  createTask,
  deleteSubtask,
  deleteTask,
  duplicateTask,
  listProjects,
  listTasks,
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
import { type Selection } from '../components/TaskHierarchyTree';
import type { MaterialLine, Project, Subtask, Task, TaskStatus, UpdateTaskInput } from '../types';
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

interface TasksPageProps {
  suggestedProjectName?: string;
  /** Bumped when another view (e.g. agent) mutates tasks; triggers refetch without remounting. */
  externalRefreshKey?: number;
  activeProjectId: string | null;
  onActiveProjectChange: (projectId: string | null) => void;
  onNeedProject?: () => void;
  pendingSelection?: Selection | null;
  onPendingSelectionApplied?: () => void;
}

type PendingConfirm = {
  kind: 'delete-item';
  label: string;
  keepChildren: boolean;
  hasChildren: boolean;
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
  const [taskListExpanded, setTaskListExpanded] = useState(true);
  const [projectDialogTaskId, setProjectDialogTaskId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const lastExternalRefreshKey = useRef(externalRefreshKey);

  useEffect(() => {
    if (creatingTaskForProjectId || addingSubtask) {
      setTaskListExpanded(true);
    }
  }, [creatingTaskForProjectId, addingSubtask]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [taskResponse, projectResponse] = await Promise.all([listTasks(), listProjects()]);
      setTasks(taskResponse.tasks);
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

  useEffect(() => {
    if (tasks.length === 0) {
      setSelection(null);
      return;
    }

    setSelection((current) => {
      if (!current) {
        return { kind: 'task', taskId: tasks[0]._id };
      }

      const task = tasks.find((item) => item._id === current.taskId);
      if (!task) {
        return { kind: 'task', taskId: tasks[0]._id };
      }

      if (current.kind === 'subtask' && !findSubtaskByPath(task.subtasks, current.path)) {
        return { kind: 'task', taskId: task._id };
      }

      return current;
    });
  }, [tasks]);

  const applyTaskUpdate = useCallback((updatedTask: Task) => {
    setTasks((current) => current.map((task) => (task._id === updatedTask._id ? updatedTask : task)));
  }, []);

  const resetHierarchyModes = useCallback(() => {
    setAddingSubtask(false);
    setActionError(null);
  }, []);

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
      const status: TaskStatus = done ? 'done' : 'todo';
      // Un-checking also resets progress so the indicator doesn't stay at 100%.
      // Executors may only send status; the server rejects other fields for them.
      const patch =
        !done && activeProject?.canEdit
          ? { status, percentComplete: 0, lastProgressField: 'percent' as const }
          : { status };
      const { task } =
        path.length === 0
          ? await updateTask(taskId, patch)
          : await updateSubtask(taskId, path, patch);
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
          const response = await listTasks();
          setTasks(response.tasks);
          const promotedId =
            result && 'promotedTasks' in result && result.promotedTasks?.[0]?._id;
          setSelection(
            promotedId
              ? { kind: 'task', taskId: promotedId }
              : response.tasks.length > 0
                ? { kind: 'task', taskId: response.tasks[0]._id }
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
          const response = await listTasks();
          setTasks(response.tasks);
          setSelection({ kind: 'task', taskId: selectedTask._id });
        }
      }
      resetHierarchyModes();
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
      return current;
    });
  }, [activeProjectId, tasks, pendingSelection, onPendingSelectionApplied]);

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

  const editableProjects = useMemo(
    () => flattenProjectTree(buildProjectTree(projects.filter((project) => project.canEdit))),
    [projects]
  );

  const activeProject = useMemo(
    () => projects.find((p) => p._id === resolvedActiveProjectId) ?? null,
    [projects, resolvedActiveProjectId]
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
      const statusOnly = !activeProject?.canEdit && Boolean(activeProject?.canUpdateStatus);

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
    [activeProject, applyTaskUpdate, projects, resolveAndRefreshProjects]
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

  const newTaskFormValues = useMemo(
    () => emptyFormValues(activeProjectGroup?.projectName ?? ''),
    [activeProjectGroup?.projectName]
  );

  const newSubtaskFormValues = useMemo(() => emptyFormValues(), []);

  const activeProjectTasks = activeProjectGroup?.tasks ?? [];

  const projectDialogTask = useMemo(
    () => (projectDialogTaskId ? tasks.find((task) => task._id === projectDialogTaskId) ?? null : null),
    [projectDialogTaskId, tasks]
  );

  async function handleConfirmDialog(dontAskAgain: boolean) {
    if (!pendingConfirm) return;
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
    resetHierarchyModes();
    setCreatingTaskForProjectId(null);
    setSelection(next);
  };

  const handleStartAddTask = (projectId: string) => {
    setCreatingTaskForProjectId((current) => {
      const next = current === projectId ? null : projectId;
      if (next) {
        setSelection(null);
      }
      return next;
    });
    setAddingSubtask(false);
    setActionError(null);
  };

  const hasSelection = Boolean(selection && selectedTask);
  const isAddingTask = creatingTaskForProjectId === resolvedActiveProjectId;
  const addTaskLabel = isAddingTask ? 'Cancel' : '+ Add task';
  const addSubtaskButtonLabel = addingSubtask ? 'Cancel' : '+ Add subtask';
  const addSubtaskLabel = detail ? `Add subtask to "${detail.title}"` : 'Add subtask';

  const handleAddTaskClick = () => {
    if (isAddingTask) {
      setCreatingTaskForProjectId(null);
      setActionError(null);
      return;
    }
    if (resolvedActiveProjectId) {
      handleStartAddTask(resolvedActiveProjectId);
    }
  };

  const handleAddSubtaskClick = () => {
    if (!hasSelection) return;
    setAddingSubtask((current) => !current);
    setCreatingTaskForProjectId(null);
    setActionError(null);
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
            projectCount={projects.length}
            taskCount={activeProjectTasks.length}
            taskListExpanded={taskListExpanded}
            selectedTaskTitle={detail?.title}
            onTaskListExpandedChange={setTaskListExpanded}
            onOpenProjects={() => onNeedProject?.()}
          />

          <div className={`tasks-layout${taskListExpanded ? '' : ' tasks-layout-task-list-collapsed'}`}>
            {taskListExpanded && activeProjectGroup && (
              <TaskListPanel
                tasks={activeProjectGroup.tasks}
                selection={selection}
                saving={saving}
                addTaskLabel={addTaskLabel}
                addSubtaskLabel={addSubtaskButtonLabel}
                showAddSubtask={Boolean(hasSelection && activeProject?.canEdit)}
                addDisabled={!resolvedActiveProjectId || !activeProject?.canEdit}
                onAddTaskClick={handleAddTaskClick}
                onAddSubtaskClick={handleAddSubtaskClick}
                onDelete={handleDelete}
                onSelect={handleSelect}
                canToggleDone={Boolean(activeProject?.canEdit || activeProject?.canUpdateStatus)}
                onToggleDone={handleToggleDone}
                onMoveSubtask={handleMoveSubtask}
                onMoveUp={handleMoveUp}
                onPromoteSubtask={handlePromoteSubtask}
                onMoveTask={handleMoveTask}
                onAttachTask={handleAttachTask}
                canManageProjects={Boolean(activeProject?.canEdit)}
                onOpenProjectDialog={setProjectDialogTaskId}
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
                  onSubmit={(values) => handleCreateTask(values, creatingTaskForProjectId)}
                  onCancel={() => setCreatingTaskForProjectId(null)}
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
                  onSubmit={handleAddSubtask}
                  onCancel={() => setAddingSubtask(false)}
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
                  canEditProject={Boolean(activeProject?.canEdit)}
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
                  disabled={!activeProject?.canEdit}
                  statusEditable={Boolean(activeProject?.canUpdateStatus)}
                  autoSave={taskDetailAutoSave}
                />
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
            } finally {
              setSaving(false);
            }
          }}
        />
      )}

      {pendingConfirm && (
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
