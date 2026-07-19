import { useState } from 'react';
import type { Project, Task } from '../types';
import { taskProjectIds } from '../utils/project';

type ProjectAction = 'move' | 'share' | 'duplicate';

interface TaskProjectDialogProps {
  task: Task;
  projects: Project[];
  editableProjects: Project[];
  currentProjectId: string | null;
  saving: boolean;
  onClose: () => void;
  onMove: (projectId: string) => Promise<void>;
  onShare: (projectId: string) => Promise<void>;
  onDuplicate: (projectId: string) => Promise<void>;
  onUnlink: (projectId: string) => Promise<void>;
}

export function TaskProjectDialog({
  task,
  projects,
  editableProjects,
  currentProjectId,
  saving,
  onClose,
  onMove,
  onShare,
  onDuplicate,
  onUnlink,
}: TaskProjectDialogProps) {
  const linkedIds = taskProjectIds(task);
  const [action, setAction] = useState<ProjectAction>('move');
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const linkedProjects = linkedIds
    .map((id) => projects.find((project) => project._id === id))
    .filter((project): project is Project => Boolean(project));

  const shareTargets = editableProjects.filter((project) => !linkedIds.includes(project._id));
  const moveTargets = editableProjects.filter((project) => project._id !== linkedIds[0]);

  const targetValid =
    Boolean(targetId) &&
    (action === 'duplicate' ||
      (action === 'move' && moveTargets.some((p) => p._id === targetId)) ||
      (action === 'share' && shareTargets.some((p) => p._id === targetId)));

  const actionLabel =
    action === 'move' ? 'Move' : action === 'share' ? 'Also appear in' : 'Duplicate';

  const run = async () => {
    if (!targetId) {
      setError('Choose a target project');
      return;
    }
    if (!targetValid) {
      setError(
        action === 'move'
          ? 'Choose a different project to move to'
          : action === 'share'
            ? 'Choose a project this task is not already in'
            : 'Choose a target project'
      );
      return;
    }
    setError(null);
    try {
      if (action === 'move') await onMove(targetId);
      else if (action === 'share') await onShare(targetId);
      else await onDuplicate(targetId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  };

  const handleUnlink = async (projectId: string) => {
    setError(null);
    try {
      await onUnlink(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove project');
    }
  };

  return (
    <div className="auth-dialog-backdrop" onClick={saving ? undefined : onClose}>
      <div
        className="auth-dialog task-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-project-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="task-project-dialog-title">Projects · {task.title}</h2>

        <ul className="task-project-links">
          {linkedProjects.map((project) => (
            <li key={project._id}>
              <span>{project.name}</span>
              {linkedIds.length > 1 && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  onClick={() => void handleUnlink(project._id)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>

        <fieldset className="task-project-action-fieldset" disabled={saving}>
          <legend>Action</legend>
          <label className="task-project-action-option">
            <input
              type="radio"
              name="task-project-action"
              value="move"
              checked={action === 'move'}
              onChange={() => setAction('move')}
            />
            <span>Move to</span>
          </label>
          <label className="task-project-action-option">
            <input
              type="radio"
              name="task-project-action"
              value="share"
              checked={action === 'share'}
              onChange={() => setAction('share')}
            />
            <span>Also appear in</span>
          </label>
          <label className="task-project-action-option">
            <input
              type="radio"
              name="task-project-action"
              value="duplicate"
              checked={action === 'duplicate'}
              onChange={() => setAction('duplicate')}
            />
            <span>Duplicate as new</span>
          </label>
        </fieldset>

        <label className="field">
          <span>Target project</span>
          <select
            value={targetId}
            disabled={saving}
            onChange={(event) => setTargetId(event.target.value)}
          >
            <option value="">Select…</option>
            {editableProjects.map((project) => (
              <option key={project._id} value={project._id}>
                {project.name}
                {currentProjectId === project._id ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </label>

        {error && <p className="project-toolbar-error">{error}</p>}

        <div className="auth-dialog-actions">
          <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving || !targetValid}
            onClick={() => void run()}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
