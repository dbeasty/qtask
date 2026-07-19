import { TaskHierarchyTree, type Selection } from './TaskHierarchyTree';
import type { Task } from '../types';

interface ProjectSectionProps {
  tasks: Task[];
  selection: Selection | null;
  saving: boolean;
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
  onDelete: (keepChildren?: boolean) => void | Promise<boolean>;
  canManageProjects?: boolean;
  onOpenProjectDialog?: (taskId: string) => void;
}

export function ProjectSection({
  tasks,
  selection,
  saving,
  onSelect,
  canToggleDone,
  onToggleDone,
  onMoveSubtask,
  onMoveUp,
  onPromoteSubtask,
  onMoveTask,
  onAttachTask,
  onDelete,
  canManageProjects,
  onOpenProjectDialog,
}: ProjectSectionProps) {
  return (
    <div className="project-section">
      {tasks.length > 0 ? (
        <TaskHierarchyTree
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
      ) : (
        <p className="muted project-section-empty">No tasks in this project yet.</p>
      )}
    </div>
  );
}
