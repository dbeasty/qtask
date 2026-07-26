import { ProjectSection } from './ProjectSection';
import type { Selection } from './TaskHierarchyTree';
import type { Task } from '../types';

interface TaskListPanelProps {
  tasks: Task[];
  selection: Selection | null;
  saving: boolean;
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
  canDeleteTask?: (task: Task) => boolean;
}

export function TaskListPanel({
  tasks,
  selection,
  saving,
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
  canDeleteTask,
}: TaskListPanelProps) {
  return (
    <aside className="task-list-panel">
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
          canDeleteTask={canDeleteTask}
        />
      </div>
    </aside>
  );
}
