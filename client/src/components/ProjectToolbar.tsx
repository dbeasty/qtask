import type { Project } from '../types';

interface ProjectToolbarProps {
  activeProject: Project | null;
  projectCount: number;
  taskCount: number;
  taskListExpanded: boolean;
  selectedTaskTitle?: string;
  onTaskListExpandedChange: (expanded: boolean) => void;
  onOpenProjects: () => void;
}

export function ProjectToolbar({
  activeProject,
  projectCount,
  taskCount,
  taskListExpanded,
  selectedTaskTitle,
  onTaskListExpandedChange,
  onOpenProjects,
}: ProjectToolbarProps) {
  const taskCountLabel = `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
  const projectCountLabel = `${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`;

  return (
    <div className="project-toolbar-wrap">
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
              <span className="project-toolbar-collapsed-meta">({projectCountLabel})</span>
            </>
          ) : (
            <span className="project-toolbar-collapsed-meta">
              {projectCount === 0 ? 'No projects' : `(${projectCountLabel})`}
            </span>
          )}
        </button>

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
      </div>
    </div>
  );
}
