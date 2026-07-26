import type { ReactNode } from 'react';
import type { Project } from '../types';

interface ProjectToolbarProps {
  activeProject: Project | null;
  projectCount: number;
  taskCount: number;
  taskListExpanded: boolean;
  onTaskListExpandedChange: (expanded: boolean) => void;
  onOpenProjects: () => void;
  listActions?: ReactNode;
}

export function ProjectToolbar({
  activeProject,
  projectCount,
  taskCount,
  taskListExpanded,
  onTaskListExpandedChange,
  onOpenProjects,
  listActions,
}: ProjectToolbarProps) {
  const taskCountLabel = `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
  const projectCountLabel = `${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`;

  return (
    <div className="project-toolbar-wrap floating-bar">
      <div className="context-bar-row context-bar-row-stacked">
        <button
          type="button"
          className="project-toolbar-collapsed context-bar-project-link"
          onClick={onOpenProjects}
        >
          <span className="project-toolbar-collapsed-label">Current project</span>
          {activeProject ? (
            <>
              <span className="project-toolbar-collapsed-sep">·</span>
              <span className="project-toolbar-collapsed-name">{activeProject.name}</span>
            </>
          ) : (
            <span className="project-toolbar-collapsed-meta">
              {projectCount === 0 ? 'No projects' : `(${projectCountLabel})`}
            </span>
          )}
        </button>

        <div className="context-bar-list-row">
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
            <span className="project-toolbar-collapsed-meta">({taskCountLabel})</span>
          </button>
          {listActions ? <div className="context-bar-actions">{listActions}</div> : null}
        </div>
      </div>
    </div>
  );
}
