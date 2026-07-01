import { TaskHierarchyTree, type Selection } from './TaskHierarchyTree';
import type { Task } from '../types';

interface ProjectSectionProps {
  tasks: Task[];
  selection: Selection | null;
  saving: boolean;
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

export function ProjectSection({
  tasks,
  selection,
  saving,
  onSelect,
  onMoveSubtask,
  onMoveUp,
  onPromoteSubtask,
  onMoveTask,
  onAttachTask,
}: ProjectSectionProps) {
  return (
    <div className="project-section">
      {tasks.length > 0 ? (
        <TaskHierarchyTree
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
      ) : (
        <p className="muted project-section-empty">No tasks in this project yet.</p>
      )}
    </div>
  );
}
