import { useEffect, useRef, useState } from 'react';
import type { Project } from '../types';

interface ProjectToolbarProps {
  projects: Project[];
  activeProjectId: string | null;
  activeProject: Project | null;
  taskCount: number;
  saving: boolean;
  loading: boolean;
  creatingProject: boolean;
  newProjectName: string;
  taskListExpanded: boolean;
  selectedTaskTitle?: string;
  onTaskListExpandedChange: (expanded: boolean) => void;
  onSelectProject: (projectId: string) => void;
  onRename: (projectId: string, name: string) => Promise<void>;
  onDeleteProject: () => void;
  onRefresh: () => void;
  onToggleCreateProject: () => void;
  onNewProjectNameChange: (name: string) => void;
  onCreateProject: () => void;
  onCancelCreateProject: () => void;
}

export function ProjectToolbar({
  projects,
  activeProjectId,
  activeProject,
  taskCount,
  saving,
  loading,
  creatingProject,
  newProjectName,
  taskListExpanded,
  selectedTaskTitle,
  onTaskListExpandedChange,
  onSelectProject,
  onRename,
  onDeleteProject,
  onRefresh,
  onToggleCreateProject,
  onNewProjectNameChange,
  onCreateProject,
  onCancelCreateProject,
}: ProjectToolbarProps) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(activeProject?.name ?? '');
  const [saveError, setSaveError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(activeProject?.name ?? '');

  useEffect(() => {
    const projectName = activeProject?.name ?? '';
    setName(projectName);
    lastSavedRef.current = projectName;
  }, [activeProject?.name, activeProjectId]);

  useEffect(() => {
    if (creatingProject) {
      setExpanded(true);
    }
  }, [creatingProject]);

  const scheduleRename = (nextName: string) => {
    if (!activeProjectId) return;
    setName(nextName);
    setSaveError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === lastSavedRef.current) return;
      try {
        await onRename(activeProjectId, trimmed);
        lastSavedRef.current = trimmed;
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to rename project');
        setName(lastSavedRef.current);
      }
    }, 500);
  };

  const taskCountLabel = `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;

  return (
    <div className="project-toolbar-wrap">
      <div className="context-bar-row">
        <button
          type="button"
          className={`project-toolbar-collapsed context-bar-tasks-toggle${taskListExpanded ? ' expanded' : ''}`}
          aria-expanded={taskListExpanded}
          onClick={() => onTaskListExpandedChange(!taskListExpanded)}
        >
          <span
            className={`project-toolbar-chevron${taskListExpanded ? ' expanded' : ''}`}
            aria-hidden="true"
          >
            ›
          </span>
          <span className="project-toolbar-collapsed-label">Tasks</span>
          {selectedTaskTitle && (
            <>
              <span className="project-toolbar-collapsed-sep">·</span>
              <span className="project-toolbar-collapsed-name">{selectedTaskTitle}</span>
            </>
          )}
          <span className="project-toolbar-collapsed-meta">({taskCountLabel})</span>
        </button>

        <button
          type="button"
          className={`project-toolbar-collapsed context-bar-project-toggle${expanded ? ' expanded' : ''}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className={`project-toolbar-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true">
            ›
          </span>
          <span className="project-toolbar-collapsed-label">Project</span>
          {activeProject && (
            <>
              <span className="project-toolbar-collapsed-sep">·</span>
              <span className="project-toolbar-collapsed-name">{activeProject.name}</span>
              <span className="project-toolbar-collapsed-meta">({taskCountLabel})</span>
            </>
          )}
          {!activeProject && projects.length === 0 && (
            <span className="project-toolbar-collapsed-meta">No projects</span>
          )}
        </button>
      </div>

      {expanded && (
        <div className="project-toolbar">
          <label className="project-toolbar-field">
            <span className="project-toolbar-label">Project</span>
            <select
              className="project-toolbar-select"
              value={activeProjectId ?? ''}
              onChange={(event) => onSelectProject(event.target.value)}
              disabled={loading || saving || projects.length === 0}
            >
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((project) => (
                <option key={project._id} value={project._id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          {activeProject && (
            <>
              <label className="project-toolbar-field project-toolbar-rename">
                <span className="project-toolbar-label">Name</span>
                <input
                  type="text"
                  className="project-toolbar-name"
                  value={name}
                  onChange={(event) => scheduleRename(event.target.value)}
                  onBlur={() => {
                    if (!name.trim()) {
                      setName(lastSavedRef.current);
                    }
                  }}
                  disabled={saving}
                  aria-label="Project name"
                />
              </label>
              <span className="project-toolbar-meta">{taskCountLabel}</span>
            </>
          )}

          <div className="project-toolbar-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onToggleCreateProject}
              disabled={loading || saving}
            >
              {creatingProject ? 'Cancel' : 'New project'}
            </button>
            {activeProject && (
              <button
                type="button"
                className="danger-button"
                onClick={onDeleteProject}
                disabled={loading || saving}
              >
                Delete project
              </button>
            )}
            <button type="button" className="secondary-button" onClick={onRefresh} disabled={loading || saving}>
              Refresh
            </button>
          </div>
          {saveError && <span className="project-toolbar-error">{saveError}</span>}
        </div>
      )}

      {creatingProject && (
        <div className="inline-form-panel project-create-panel">
          <h3 className="panel-title">New project</h3>
          <div className="project-create-form">
            <label className="task-form-field">
              Project name
              <input
                type="text"
                value={newProjectName}
                onChange={(event) => onNewProjectNameChange(event.target.value)}
                placeholder="Enter project name"
                disabled={saving}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onCreateProject();
                  }
                }}
              />
            </label>
            <div className="task-form-actions">
              <button
                type="button"
                className="primary-button"
                onClick={onCreateProject}
                disabled={saving || !newProjectName.trim()}
              >
                Create project
              </button>
              <button type="button" className="secondary-button" onClick={onCancelCreateProject} disabled={saving}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
