import type { ReactNode } from 'react';
import type { Project } from '../types';
import { CurrentProjectLabel } from './CurrentProjectBar';

interface ProjectToolbarProps {
  activeProject: Project | null;
  projects?: Project[];
  projectCount: number;
  taskCount: number;
  taskListExpanded: boolean;
  onTaskListExpandedChange: (expanded: boolean) => void;
  onOpenProjects: () => void;
  onSelectProject?: (projectId: string) => void;
  listActions?: ReactNode;
}

export function ProjectToolbar({
  activeProject,
  projects,
  projectCount,
  taskCount,
  taskListExpanded,
  onTaskListExpandedChange,
  onOpenProjects,
  onSelectProject,
  listActions,
}: ProjectToolbarProps) {
  const taskCountLabel = `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;

  return (
    <div className="project-toolbar-wrap floating-bar">
      <div className="context-bar-row context-bar-row-stacked">
        <CurrentProjectLabel
          activeProject={activeProject}
          projects={projects}
          projectCount={projectCount}
          onOpenProjects={onOpenProjects}
          onSelectProject={onSelectProject}
        />

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
