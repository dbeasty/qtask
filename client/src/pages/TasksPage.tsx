import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addSubtask,
  createTask,
  deleteSubtask,
  deleteTask,
  listProjects,
  listTasks,
  updateSubtask,
  updateTask,
} from '../api/client';
import { parseTagsInput, TaskForm, type TaskFormValues } from '../components/TaskForm';
import type { Project, Subtask, Task } from '../types';

type TaskSelection = { kind: 'task'; taskId: string };
type SubtaskSelection = { kind: 'subtask'; taskId: string; path: string[] };
type Selection = TaskSelection | SubtaskSelection;

interface TasksPageProps {
  onTasksChanged?: () => void;
}

function findSubtaskByPath(subtasks: Subtask[], path: string[]): Subtask | null {
  let current: Subtask[] = subtasks;
  let node: Subtask | null = null;

  for (const id of path) {
    node = current.find((subtask) => subtask._id === id) ?? null;
    if (!node) return null;
    current = node.subtasks;
  }

  return node;
}

function countNestedSubtasks(subtasks: Subtask[]): number {
  return subtasks.reduce((count, subtask) => count + 1 + countNestedSubtasks(subtask.subtasks), 0);
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

function taskToFormValues(task: Task): TaskFormValues {
  return {
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    projectId: task.projectId ?? '',
    tags: task.tags.join(', '),
  };
}

function subtaskToFormValues(subtask: Subtask): TaskFormValues {
  return {
    title: subtask.title,
    description: subtask.description ?? '',
    status: subtask.status,
    priority: subtask.priority,
    projectId: '',
    tags: '',
  };
}

function emptyFormValues(): TaskFormValues {
  return {
    title: '',
    description: '',
    status: 'todo',
    priority: 'medium',
    projectId: '',
    tags: '',
  };
}

function subtaskParentPath(selection: Selection): string[] {
  return selection.kind === 'subtask' ? selection.path : [];
}

export function TasksPage({ onTasksChanged }: TasksPageProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [addingSubtask, setAddingSubtask] = useState(false);

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

  const applyTaskUpdate = useCallback(
    (updatedTask: Task) => {
      setTasks((current) => current.map((task) => (task._id === updatedTask._id ? updatedTask : task)));
      onTasksChanged?.();
    },
    [onTasksChanged]
  );

  const resetDetailModes = useCallback(() => {
    setAddingSubtask(false);
    setActionError(null);
  }, []);

  const handleCreateTask = async (values: TaskFormValues) => {
    setSaving(true);
    setActionError(null);
    try {
      const { task } = await createTask({
        title: values.title,
        description: values.description || undefined,
        status: values.status,
        priority: values.priority,
        projectId: values.projectId || undefined,
        tags: parseTagsInput(values.tags),
      });
      setTasks((current) => [task, ...current]);
      setSelection({ kind: 'task', taskId: task._id });
      setCreatingTask(false);
      onTasksChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSaving(false);
    }
  };

  const handleDetailSave = async (values: TaskFormValues) => {
    if (!selection || !selectedTask) return;

    if (selection.kind === 'task') {
      const { task } = await updateTask(selectedTask._id, {
        title: values.title,
        description: values.description || undefined,
        status: values.status,
        priority: values.priority,
        projectId: values.projectId || null,
        tags: parseTagsInput(values.tags),
      });
      applyTaskUpdate(task);
    } else {
      const { task } = await updateSubtask(selectedTask._id, selection.path, {
        title: values.title,
        description: values.description || undefined,
        status: values.status,
        priority: values.priority,
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
      resetDetailModes();
      onTasksChanged?.();
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

  const detail = selectedTask && selection ? getDetailItem(selectedTask, selection) : null;
  const breadcrumbs = selectedTask && selection ? buildBreadcrumb(selectedTask, selection) : [];

  const editFormValues = useMemo(() => {
    if (!selectedTask || !selection) return emptyFormValues();
    if (selection.kind === 'task') return taskToFormValues(selectedTask);
    const subtask = findSubtaskByPath(selectedTask.subtasks, selection.path);
    return subtask ? subtaskToFormValues(subtask) : emptyFormValues();
  }, [selectedTask, selection]);

  const selectionKey =
    selection === null
      ? ''
      : `${selection.taskId}:${selection.kind === 'subtask' ? selection.path.join('/') : ''}`;

  const handleSelect = (next: Selection) => {
    resetDetailModes();
    setSelection(next);
  };

  return (
    <section className="tasks-page">
      <div className="page-header">
        <h2>Tasks</h2>
        <div className="page-header-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              setCreatingTask((current) => !current);
              setActionError(null);
            }}
            disabled={loading || saving}
          >
            {creatingTask ? 'Cancel' : 'New task'}
          </button>
          <button type="button" className="secondary-button" onClick={refresh} disabled={loading || saving}>
            Refresh
          </button>
        </div>
      </div>

      {error && <p className="error-banner">{error}</p>}
      {actionError && <p className="error-banner">{actionError}</p>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && tasks.length === 0 && !creatingTask && (
        <div className="tasks-empty-state">
          <p className="muted">No tasks yet.</p>
          <button
            type="button"
            className="primary-button"
            onClick={() => setCreatingTask(true)}
            disabled={saving}
          >
            Create your first task
          </button>
        </div>
      )}

      {(creatingTask || tasks.length > 0) && !loading && (
        <div className="tasks-layout">
          <aside className="task-list-panel">
            {creatingTask && (
              <div className="inline-form-panel">
                <h3 className="panel-title">New task</h3>
                <TaskForm
                  mode="create"
                  initialValues={emptyFormValues()}
                  showProjectFields
                  projects={projects}
                  submitLabel="Create task"
                  saving={saving}
                  onSubmit={handleCreateTask}
                  onCancel={() => setCreatingTask(false)}
                />
              </div>
            )}

            {tasks.length > 0 && (
              <>
                <h3 className="panel-title">All tasks</h3>
                <ul className="task-list">
                  {tasks.map((task) => (
                    <li key={task._id}>
                      <button
                        type="button"
                        className={`task-list-item${
                          selection?.taskId === task._id && selection.kind === 'task' ? ' active' : ''
                        }`}
                        onClick={() => handleSelect({ kind: 'task', taskId: task._id })}
                      >
                        <span className="task-list-title">{task.title}</span>
                        <span className="task-list-meta">
                          {task.status} · {task.percentComplete}%
                          {task.subtasks.length > 0 && ` · ${countNestedSubtasks(task.subtasks)} subtasks`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>

          {selectedTask && detail && selection && (
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

              <div className="task-detail-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setAddingSubtask((current) => !current);
                    setActionError(null);
                  }}
                  disabled={saving}
                >
                  {addingSubtask ? 'Cancel add' : 'Add subtask'}
                </button>
                <button type="button" className="danger-button" onClick={handleDelete} disabled={saving}>
                  Delete
                </button>
              </div>

              <TaskForm
                key={selectionKey}
                mode="edit"
                className="task-detail-form"
                initialValues={editFormValues}
                showProjectFields={selection.kind === 'task'}
                projects={projects}
                autoSave={{ onSave: handleDetailSave }}
                readOnlyFields={['progress']}
                progressValue={detail.percentComplete}
              />

              <section className="subtask-section">
                <h4>Subtasks</h4>

                {addingSubtask && (
                  <div className="inline-form-panel">
                    <TaskForm
                      mode="create"
                      initialValues={emptyFormValues()}
                      submitLabel="Add subtask"
                      saving={saving}
                      onSubmit={handleAddSubtask}
                      onCancel={() => setAddingSubtask(false)}
                    />
                  </div>
                )}

                {detail.subtasks.length > 0 ? (
                  <ul className="subtask-list">
                    {detail.subtasks.map((subtask) => {
                      const subtaskPath =
                        selection.kind === 'subtask' ? [...selection.path, subtask._id] : [subtask._id];
                      const isActive =
                        selection.kind === 'subtask' &&
                        selection.path.length === subtaskPath.length &&
                        selection.path.every((id, index) => id === subtaskPath[index]);

                      return (
                        <li key={subtask._id}>
                          <button
                            type="button"
                            className={`subtask-list-item${isActive ? ' active' : ''}`}
                            onClick={() =>
                              handleSelect({
                                kind: 'subtask',
                                taskId: selectedTask._id,
                                path: subtaskPath,
                              })
                            }
                          >
                            <span className="subtask-list-title">{subtask.title}</span>
                            <span className="subtask-list-meta">
                              {subtask.status} · {subtask.percentComplete}%
                              {subtask.subtasks.length > 0 &&
                                ` · ${countNestedSubtasks(subtask.subtasks)} nested`}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  !addingSubtask && <p className="muted">No subtasks yet.</p>
                )}
              </section>
            </article>
          )}
        </div>
      )}
    </section>
  );
}
