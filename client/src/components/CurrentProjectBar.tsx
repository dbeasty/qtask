import { useMemo } from 'react';
import type { Project } from '../types';
import { getProjectAncestorIds } from '../utils/projectTree';

interface CurrentProjectBarProps {
  activeProject: Project | null;
  projects?: Project[];
  projectCount?: number;
  onOpenProjects?: () => void;
  onSelectProject?: (projectId: string) => void;
}

function CurrentProjectContent({
  activeProject,
  projects,
  projectCount,
  onOpenProjects,
  onSelectProject,
}: CurrentProjectBarProps) {
  const projectCountLabel =
    projectCount === undefined
      ? null
      : `${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`;

  const ancestors = useMemo(() => {
    if (!activeProject || !projects) return [];
    const byId = new Map(projects.map((project) => [project._id, project]));
    return getProjectAncestorIds(projects, activeProject._id)
      .reverse()
      .map((id) => byId.get(id))
      .filter((project): project is Project => Boolean(project));
  }, [activeProject, projects]);

  return (
    <>
      <span className="project-toolbar-collapsed-label">Current project</span>
      {activeProject ? (
        <>
          <span className="project-toolbar-collapsed-sep">·</span>
          <span className="project-toolbar-collapsed-name project-breadcrumb-name">
            {ancestors.map((ancestor) => (
              <span key={ancestor._id} className="project-breadcrumb-crumb">
                {onSelectProject ? (
                  <button
                    type="button"
                    className="project-breadcrumb-link"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectProject(ancestor._id);
                    }}
                  >
                    {ancestor.name}
                  </button>
                ) : (
                  <span className="project-breadcrumb-link">{ancestor.name}</span>
                )}
                <span className="project-breadcrumb-sep" aria-hidden="true">
                  ›
                </span>
              </span>
            ))}
            {onOpenProjects ? (
              <button
                type="button"
                className="project-breadcrumb-current project-breadcrumb-current-button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenProjects();
                }}
              >
                {activeProject.name}
              </button>
            ) : (
              <span className="project-breadcrumb-current">{activeProject.name}</span>
            )}
          </span>
        </>
      ) : projectCountLabel ? (
        <span className="project-toolbar-collapsed-meta">
          {projectCount === 0 ? 'No projects' : `(${projectCountLabel})`}
        </span>
      ) : (
        <>
          <span className="project-toolbar-collapsed-sep">·</span>
          <span className="context-bar-current-project-empty">None selected</span>
        </>
      )}
    </>
  );
}

export function CurrentProjectLabel({
  activeProject,
  projects,
  projectCount,
  onOpenProjects,
  onSelectProject,
}: CurrentProjectBarProps) {
  const className = onOpenProjects
    ? 'project-toolbar-collapsed context-bar-project-link'
    : 'context-bar-current-project muted';

  return (
    <div
      className={className}
      data-demo-step="current-project"
      role={onOpenProjects ? 'button' : undefined}
      tabIndex={onOpenProjects ? 0 : undefined}
      onClick={onOpenProjects}
      onKeyDown={
        onOpenProjects
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpenProjects();
              }
            }
          : undefined
      }
    >
      <CurrentProjectContent
        activeProject={activeProject}
        projects={projects}
        projectCount={projectCount}
        onOpenProjects={onOpenProjects}
        onSelectProject={onSelectProject}
      />
    </div>
  );
}

export function CurrentProjectBar({
  activeProject,
  projects,
  projectCount,
  onOpenProjects,
  onSelectProject,
}: CurrentProjectBarProps) {
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
      </div>
    </div>
  );
}
