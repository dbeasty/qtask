import type { Project } from '../types';

interface CurrentProjectBarProps {
  activeProject: Project | null;
  projectCount?: number;
  onOpenProjects?: () => void;
}

function CurrentProjectContent({
  activeProject,
  projectCount,
}: Pick<CurrentProjectBarProps, 'activeProject' | 'projectCount'>) {
  const projectCountLabel =
    projectCount === undefined
      ? null
      : `${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`;

  return (
    <>
      <span className="project-toolbar-collapsed-label">Current project</span>
      {activeProject ? (
        <>
          <span className="project-toolbar-collapsed-sep">·</span>
          <span className="project-toolbar-collapsed-name">{activeProject.name}</span>
          {projectCountLabel ? (
            <span className="project-toolbar-collapsed-meta">({projectCountLabel})</span>
          ) : null}
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
  projectCount,
  onOpenProjects,
}: CurrentProjectBarProps) {
  if (onOpenProjects) {
    return (
      <button
        type="button"
        className="project-toolbar-collapsed context-bar-project-link"
        onClick={onOpenProjects}
      >
        <CurrentProjectContent activeProject={activeProject} projectCount={projectCount} />
      </button>
    );
  }

  return (
    <p className="context-bar-current-project muted">
      <CurrentProjectContent activeProject={activeProject} projectCount={projectCount} />
    </p>
  );
}

export function CurrentProjectBar({
  activeProject,
  projectCount,
  onOpenProjects,
}: CurrentProjectBarProps) {
  return (
    <div className="project-toolbar-wrap">
      <div className="context-bar-row context-bar-row-stacked">
        <CurrentProjectLabel
          activeProject={activeProject}
          projectCount={projectCount}
          onOpenProjects={onOpenProjects}
        />
      </div>
    </div>
  );
}
