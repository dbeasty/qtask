import { ProjectSection } from './ProjectSection';
import type { Selection } from './TaskHierarchyTree';
import type { Task } from '../types';

interface TaskListPanelProps {
  tasks: Task[];
  selection: Selection | null;
  saving: boolean;
  addTaskLabel: string;
  addSubtaskLabel: string;
  showAddSubtask: boolean;
  addDisabled: boolean;
  onAddTaskClick: () => void;
  onAddSubtaskClick: () => void;
  onDelete: (keepChildren?: boolean) => void | Promise<boolean>;
  onSelect: (selection: Selection) => void;
  canToggleDone: boolean;
  onToggleDone: (taskId: string, path: string[], done: boolean) => void;
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
  canManageProjects?: boolean;
  onOpenProjectDialog?: (taskId: string) => void;
}

export function TaskListPanel({
  tasks,
  selection,
  saving,
  addTaskLabel,
  addSubtaskLabel,
  showAddSubtask,
  addDisabled,
  onAddTaskClick,
  onAddSubtaskClick,
  onDelete,
  onSelect,
  canToggleDone,
  onToggleDone,
  onMoveSubtask,
  onMoveUp,
  onPromoteSubtask,
  onMoveTask,
  onAttachTask,
  canManageProjects,
  onOpenProjectDialog,
}: TaskListPanelProps) {
  return (
    <aside className="task-list-panel">
      <header className="task-list-panel-header">
        <div className="task-list-panel-actions">
          <button
            type="button"
            className="primary-button"
            onClick={onAddTaskClick}
            disabled={saving || addDisabled}
          >
            {addTaskLabel}
          </button>
          {showAddSubtask && (
            <button
              type="button"
              className="primary-button"
              onClick={onAddSubtaskClick}
              disabled={saving}
            >
              {addSubtaskLabel}
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
          canToggleDone={canToggleDone}
          onToggleDone={onToggleDone}
          onMoveSubtask={onMoveSubtask}
          onMoveUp={onMoveUp}
          onPromoteSubtask={onPromoteSubtask}
          onMoveTask={onMoveTask}
          onAttachTask={onAttachTask}
          onDelete={onDelete}
          canManageProjects={canManageProjects}
          onOpenProjectDialog={onOpenProjectDialog}
        />
      </div>
    </aside>
  );
}
