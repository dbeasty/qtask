import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addSubtask,
  attachTaskAsSubtask,
  createProject,
  createTask,
  deleteProject,
  deleteSubtask,
  deleteTask,
  listProjects,
  listTasks,
  moveSubtask,
  promoteSubtask,
  reorderProjectTask,
  updateProject,
  updateSubtask,
  updateTask,
} from '../api/client';
import {
  emptyFormValues,
  parseOptionalNumber,
  parseTagsInput,
  TaskForm,
  type TaskFormValues,
} from '../components/TaskForm';
import { ProjectToolbar } from '../components/ProjectToolbar';
import { TaskListPanel } from '../components/TaskListPanel';
import { type Selection } from '../components/TaskHierarchyTree';
import type { Project, Subtask, Task, UpdateTaskInput } from '../types';
import {
  getDefaultProject,
  groupTasksByProject,
  projectIdToName,
  resolveProjectId,
} from '../utils/project';
import {
  findPathBySubtaskId,
  findSubtaskByPath,
  getMoveUpAction,
} from '../utils/taskTree';

interface TasksPageProps {
  suggestedProjectName?: string;
  /** Bumped when another view (e.g. chat) mutates tasks; triggers refetch without remounting. */
  externalRefreshKey?: number;
}

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
  const crumbs: Array<{ label: string; selection: Selection }> = [
    { label: task.title, selection: { kind: 'task', taskId: task._id } },
  ];

  if (selection.kind === 'subtask') {
    let current = task.subtasks;
    const path: string[] = [];

    for (const id of selection.path) {
      const subtask = current.find((item) => item._id === id);
      if (!subtask) break;
      path.push(id);
      crumbs.push({
        label: subtask.title,
        selection: { kind: 'subtask', taskId: task._id, path: [...path] },
      });
      current = subtask.subtasks;
    }
  }

  return crumbs;
}

function formatOptionalHours(value?: number): string {
  return value !== undefined && value !== null ? String(value) : '';
}

function taskToFormValues(task: Task, projects: Project[]): TaskFormValues {
  return {
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    projectName: projectIdToName(task.projectId ?? '', projects),
    tags: task.tags.join(', '),
    percentComplete: task.percentComplete,
    progressShare: '',
    hoursSpent: formatOptionalHours(task.hoursSpent),
    hoursRemaining: formatOptionalHours(task.hoursRemaining),
    lastProgressField: task.lastProgressField ?? 'percent',
  };
}

function subtaskToFormValues(subtask: Subtask): TaskFormValues {
  return {
    title: subtask.title,
    description: subtask.description ?? '',
    status: subtask.status,
    priority: subtask.priority,
    projectName: '',
    tags: '',
    percentComplete: subtask.percentComplete,
    progressShare: subtask.progressShare !== undefined ? String(subtask.progressShare) : '',
    hoursSpent: formatOptionalHours(subtask.hoursSpent),
    hoursRemaining: formatOptionalHours(subtask.hoursRemaining),
    lastProgressField: subtask.lastProgressField ?? 'percent',
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

function subtaskParentPath(selection: Selection): string[] {
  return selection.kind === 'subtask' ? selection.path : [];
}

export function TasksPage({ suggestedProjectName = '', externalRefreshKey = 0 }: TasksPageProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [creatingTaskForProjectId, setCreatingTaskForProjectId] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [taskListExpanded, setTaskListExpanded] = useState(true);
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

  const resolveAndRefreshProjects = async (projectName: string) => {
    const projectId = await resolveProjectId(projectName, projects, createProject);
    if (projectName.trim() && projectId && !projects.some((project) => project._id === projectId)) {
      const { projects: nextProjects } = await listProjects();
      setProjects(nextProjects);
    }
    return projectId;
  };

  const handleCreateTask = async (values: TaskFormValues, forProjectId: string) => {
    setSaving(true);
    setActionError(null);
    try {
      const { task } = await createTask({
        title: values.title,
        description: values.description || undefined,
        status: values.status,
        priority: values.priority,
        projectId: forProjectId,
        tags: parseTagsInput(values.tags),
      });
      setTasks((current) => [task, ...current]);
      setSelection({ kind: 'task', taskId: task._id });
      setActiveProjectId(forProjectId);
      setCreatingTaskForProjectId(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateProject = async () => {
    const trimmed = newProjectName.trim();
    if (!trimmed) return;

    setSaving(true);
    setActionError(null);
    try {
      const { project } = await createProject({ name: trimmed });
      setProjects((current) => [...current, project]);
      setActiveProjectId(project._id);
      setCreatingProject(false);
      setNewProjectName('');
      setCreatingTaskForProjectId(project._id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSaving(false);
    }
  };

  const handleDetailSave = async (values: TaskFormValues) => {
    if (!selection || !selectedTask) return;

    if (selection.kind === 'task') {
      const projectId = await resolveAndRefreshProjects(values.projectName);
      const progressPatch = selectedTask.subtasks.length === 0 ? buildProgressPatch(values) : {};
      const { task } = await updateTask(selectedTask._id, {
        title: values.title,
        description: values.description || undefined,
        status: values.status,
        priority: values.priority,
        projectId: projectId ?? null,
        tags: parseTagsInput(values.tags),
        ...progressPatch,
      });
      applyTaskUpdate(task);
    } else {
      const isLeaf = (findSubtaskByPath(selectedTask.subtasks, selection.path)?.subtasks.length ?? 0) === 0;
      const progressPatch = isLeaf ? buildProgressPatch(values) : {};
      const { task } = await updateSubtask(selectedTask._id, selection.path, {
        title: values.title,
        description: values.description || undefined,
        status: values.status,
        priority: values.priority,
        ...progressPatch,
      });
      applyTaskUpdate(task);
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
      if (promotedTask.projectId) {
        setActiveProjectId(promotedTask.projectId);
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

  const handleRenameProject = async (projectId: string, name: string) => {
    const { project } = await updateProject(projectId, { name });
    setProjects((current) => current.map((item) => (item._id === projectId ? project : item)));
  };

  const handleDelete = async () => {
    if (!selection || !selectedTask) return;

    const label = selection.kind === 'task' ? 'task' : 'subtask';
    if (!window.confirm(`Delete this ${label}? This cannot be undone.`)) return;

    setSaving(true);
    setActionError(null);
    try {
      if (selection.kind === 'task') {
        await deleteTask(selectedTask._id);
        const remaining = tasks.filter((task) => task._id !== selectedTask._id);
        setTasks(remaining);
        setSelection(remaining.length > 0 ? { kind: 'task', taskId: remaining[0]._id } : null);
      } else {
        await deleteSubtask(selectedTask._id, selection.path);
        const response = await listTasks();
        setTasks(response.tasks);
        setSelection({ kind: 'task', taskId: selectedTask._id });
      }
      resetHierarchyModes();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setSaving(false);
    }
  };

  const selectedTask = useMemo(
    () => (selection ? tasks.find((task) => task._id === selection.taskId) ?? null : null),
    [selection, tasks]
  );

  useEffect(() => {
    if (!selectedTask?.projectId) return;
    setActiveProjectId(selectedTask.projectId);
  }, [selectedTask?.projectId]);

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
    if (selectedTask?.projectId && projects.some((p) => p._id === selectedTask.projectId)) {
      return selectedTask.projectId;
    }
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
  }, [selectedTask, activeProjectId, projects, suggestedProjectName]);

  const activeProject = useMemo(
    () => projects.find((p) => p._id === resolvedActiveProjectId) ?? null,
    [projects, resolvedActiveProjectId]
  );

  const activeProjectGroup = useMemo(
    () => projectGroups.find((group) => group.projectId === resolvedActiveProjectId) ?? null,
    [projectGroups, resolvedActiveProjectId]
  );

  const activeProjectTasks = activeProjectGroup?.tasks ?? [];

  const handleDeleteProject = async () => {
    if (!resolvedActiveProjectId || !activeProject) return;

    const taskCount = activeProjectTasks.length;
    const message =
      taskCount > 0
        ? `Delete project "${activeProject.name}" and all ${taskCount} tasks? This cannot be undone.`
        : `Delete project "${activeProject.name}"? This cannot be undone.`;
    if (!window.confirm(message)) return;

    setSaving(true);
    setActionError(null);
    try {
      const { nextProjectId } = await deleteProject(resolvedActiveProjectId);
      const [taskResponse, projectResponse] = await Promise.all([listTasks(), listProjects()]);
      setTasks(taskResponse.tasks);
      setProjects(projectResponse.projects);
      setActiveProjectId(nextProjectId);
      setSelection(null);
      setCreatingTaskForProjectId(null);
      resetHierarchyModes();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete project');
    } finally {
      setSaving(false);
    }
  };

  const handleSelect = (next: Selection) => {
    resetHierarchyModes();
    setCreatingTaskForProjectId(null);
    setSelection(next);
  };

  const handleSelectProject = (projectId: string) => {
    setActiveProjectId(projectId);
    resetHierarchyModes();
    setCreatingTaskForProjectId(null);

    const group = projectGroups.find((item) => item.projectId === projectId);
    if (!group || group.tasks.length === 0) {
      setSelection(null);
      return;
    }

    if (selection) {
      const selected = tasks.find((task) => task._id === selection.taskId);
      if (selected?.projectId === projectId) {
        return;
      }
    }

    setSelection({ kind: 'task', taskId: group.tasks[0]._id });
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
  const addButtonLabel = hasSelection
    ? addingSubtask
      ? 'Cancel'
      : '+ Add subtask'
    : isAddingTask
      ? 'Cancel'
      : '+ Add task';
  const addSubtaskLabel = detail ? `Add subtask to "${detail.title}"` : 'Add subtask';

  const handleAddClick = () => {
    if (hasSelection) {
      setAddingSubtask((current) => !current);
      setCreatingTaskForProjectId(null);
      setActionError(null);
      return;
    }
    if (resolvedActiveProjectId) {
      handleStartAddTask(resolvedActiveProjectId);
    }
  };

  return (
    <section className="tasks-page">
      {error && <p className="error-banner">{error}</p>}
      {actionError && <p className="error-banner">{actionError}</p>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && tasks.length === 0 && projects.length === 0 && !creatingProject && (
        <div className="tasks-empty-state">
          <p className="muted">No projects or tasks yet.</p>
          <div className="tasks-empty-state-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => setCreatingProject(true)}
              disabled={saving}
            >
              New project
            </button>
          </div>
        </div>
      )}

      {projects.length > 0 && !loading && (
        <>
          <ProjectToolbar
            projects={projects}
            activeProjectId={resolvedActiveProjectId}
            activeProject={activeProject}
            taskCount={activeProjectTasks.length}
            saving={saving}
            loading={loading}
            creatingProject={creatingProject}
            newProjectName={newProjectName}
            taskListExpanded={taskListExpanded}
            selectedTaskTitle={detail?.title}
            onTaskListExpandedChange={setTaskListExpanded}
            onSelectProject={handleSelectProject}
            onRename={handleRenameProject}
            onDeleteProject={handleDeleteProject}
            onRefresh={refresh}
            onToggleCreateProject={() => {
              setCreatingProject((current) => !current);
              setActionError(null);
            }}
            onNewProjectNameChange={setNewProjectName}
            onCreateProject={handleCreateProject}
            onCancelCreateProject={() => {
              setCreatingProject(false);
              setNewProjectName('');
            }}
          />

          <div className={`tasks-layout${taskListExpanded ? '' : ' tasks-layout-task-list-collapsed'}`}>
            {taskListExpanded && activeProjectGroup && (
              <TaskListPanel
                tasks={activeProjectGroup.tasks}
                selection={selection}
                saving={saving}
                addButtonLabel={addButtonLabel}
                hasSelection={hasSelection}
                addDisabled={!resolvedActiveProjectId}
                onAddClick={handleAddClick}
                onDelete={handleDelete}
                onSelect={handleSelect}
                onMoveSubtask={handleMoveSubtask}
                onMoveUp={handleMoveUp}
                onPromoteSubtask={handlePromoteSubtask}
                onMoveTask={handleMoveTask}
                onAttachTask={handleAttachTask}
              />
            )}

            {creatingTaskForProjectId && activeProjectGroup ? (
              <article className="task-detail-panel">
                <h3 className="panel-title">New task</h3>
                <TaskForm
                  mode="create"
                  className="task-detail-form"
                  initialValues={emptyFormValues(activeProjectGroup.projectName)}
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
                  initialValues={emptyFormValues()}
                  submitLabel={addSubtaskLabel}
                  saving={saving}
                  onSubmit={handleAddSubtask}
                  onCancel={() => setAddingSubtask(false)}
                />
              </article>
            ) : selectedTask && detail && selection ? (
              <article className="task-detail-panel">
                <nav className="task-breadcrumb" aria-label="Task navigation">
                  {breadcrumbs.map((crumb, index) => (
                    <span key={`${crumb.selection.kind}-${index}`} className="task-breadcrumb-item">
                      {index > 0 && <span className="task-breadcrumb-sep">›</span>}
                      <button
                        type="button"
                        className={
                          index === breadcrumbs.length - 1 ? 'task-breadcrumb-current' : 'task-breadcrumb-link'
                        }
                        onClick={() => handleSelect(crumb.selection)}
                        disabled={index === breadcrumbs.length - 1}
                      >
                        {crumb.label}
                      </button>
                    </span>
                  ))}
                </nav>

                <TaskForm
                  key={selectionKey}
                  mode="edit"
                  className="task-detail-form"
                  initialValues={editFormValues}
                  showProjectFields={false}
                  showProgressFields={isLeafDetail}
                  showProgressShare={selection.kind === 'subtask'}
                  readOnlyProgress={isParentDetail}
                  progressValue={detail.percentComplete}
                  projects={projects}
                  autoSave={{ onSave: handleDetailSave }}
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
    </section>
  );
}
