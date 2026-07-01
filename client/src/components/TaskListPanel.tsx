import { ProjectSection } from './ProjectSection';
import type { Selection } from './TaskHierarchyTree';
import type { Task } from '../types';

interface TaskListPanelProps {
  tasks: Task[];
  selection: Selection | null;
  saving: boolean;
  addButtonLabel: string;
  hasSelection: boolean;
  addDisabled: boolean;
  onAddClick: () => void;
  onDelete: () => void;
  onSelect: (selection: Selection) => void;
  onMoveSubtask: (
    taskId: string,
    fromPath: string[],
    toParentPath: string[],
    index?: number
  ) => void;
  onMoveUp: (taskId: string, path: string[]) => void;
  onPromoteSubtask: (taskId: string, path: string[]) => void;
  onMoveTask: (taskId: string, index: number) => void;
  onAttachTask: (
    sourceTaskId: string,
    targetTaskId: string,
    parentPath: string[],
    index?: number
  ) => void;
}

export function TaskListPanel({
  tasks,
  selection,
  saving,
  addButtonLabel,
  hasSelection,
  addDisabled,
  onAddClick,
  onDelete,
  onSelect,
  onMoveSubtask,
  onMoveUp,
  onPromoteSubtask,
  onMoveTask,
  onAttachTask,
}: TaskListPanelProps) {
  return (
    <aside className="task-list-panel">
      <header className="task-list-panel-header">
        <div className="task-list-panel-actions">
          <button
            type="button"
            className="primary-button"
            onClick={onAddClick}
            disabled={saving || addDisabled}
          >
            {addButtonLabel}
          </button>
          {hasSelection && (
            <button type="button" className="danger-button" onClick={onDelete} disabled={saving}>
              Delete
            </button>
          )}
        </div>
      </header>

      <div className="project-sections">
        <ProjectSection
          tasks={tasks}
          selection={selection}
          saving={saving}
          onSelect={onSelect}
          onMoveSubtask={onMoveSubtask}
          onMoveUp={onMoveUp}
          onPromoteSubtask={onPromoteSubtask}
          onMoveTask={onMoveTask}
          onAttachTask={onAttachTask}
        />
      </div>
    </aside>
  );
}
