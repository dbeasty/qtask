import type { AgentEntityLink as AgentEntityLinkData } from '../utils/agentEntityLink';
import { TaskProgressIndicator } from './TaskProgressIndicator';

interface AgentEntityLinkProps {
  link: AgentEntityLinkData;
  onOpenTask: (taskId: string, projectId?: string) => void;
  onOpenProject: (projectId: string) => void;
}

export function AgentEntityLink({ link, onOpenTask, onOpenProject }: AgentEntityLinkProps) {
  if (link.kind === 'task') {
    return (
      <div className="agent-entity-link">
        <div className="project-task-row">
          <span className="task-done-toggle task-done-toggle--static" aria-hidden="true">
            <TaskProgressIndicator
              status={link.status ?? 'todo'}
              percentComplete={link.percentComplete ?? 0}
            />
          </span>
          <button
            type="button"
            className="project-task-title"
            title="Open this task in Tasks"
            onClick={() => onOpenTask(link.id, link.projectId)}
          >
            {link.label}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-entity-link">
      <div className="project-task-row project-task-row--project">
        <span className="task-tree-chevron-spacer" aria-hidden="true" />
        <button
          type="button"
          className="project-task-title project-task-title--project"
          title="Open this project in Projects"
          onClick={() => onOpenProject(link.id)}
        >
          {link.label}
        </button>
      </div>
    </div>
  );
}
