import { useEffect, useMemo, useState } from 'react';
import type { Project, Subtask, Task, TaskStatus } from '../types';
import { taskBelongsToProject } from '../utils/project';
import { buildProjectTree, type ProjectTreeNode } from '../utils/projectTree';
import { buildSubtaskPath, nodeKey } from '../utils/taskTree';
import { TaskProgressIndicator } from './TaskProgressIndicator';

interface ProjectTasksListProps {
  projectId: string;
  projects: Project[];
  tasks: Task[];
  canEdit: boolean;
  onOpenTask: (taskId: string, path: string[], projectId: string) => void;
  onAddTask: (projectId: string) => void;
}

function findProjectNode(nodes: ProjectTreeNode[], projectId: string): ProjectTreeNode | null {
  for (const node of nodes) {
    if (node.project._id === projectId) return node;
    const found = findProjectNode(node.children, projectId);
    if (found) return found;
  }
  return null;
}

function sortTasks(items: Task[]): Task[] {
  return [...items].sort((a, b) => {
    const orderDiff = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return a.title.localeCompare(b.title);
  });
}

function projectTasksForProject(tasks: Task[], projectId: string): Task[] {
  return sortTasks(tasks.filter((task) => taskBelongsToProject(task, projectId)));
}

function collectSubtaskExpandKeys(taskId: string, subtasks: Subtask[], parentPath: string[], keys: Set<string>) {
  for (const subtask of subtasks) {
    if (subtask.subtasks.length > 0) {
      const path = buildSubtaskPath(parentPath, subtask._id);
      keys.add(nodeKey(taskId, path));
      collectSubtaskExpandKeys(taskId, subtask.subtasks, path, keys);
    }
  }
}

function collectProjectTaskExpandKeys(
  projectId: string,
  projectNode: ProjectTreeNode | null,
  tasks: Task[]
): Set<string> {
  const keys = new Set<string>();
  const directTasks = projectTasksForProject(tasks, projectId);

  for (const task of directTasks) {
    if (task.subtasks.length > 0) {
      keys.add(nodeKey(task._id, []));
      collectSubtaskExpandKeys(task._id, task.subtasks, [], keys);
    }
  }

  for (const childNode of projectNode?.children ?? []) {
    const childId = childNode.project._id;
    const childDirectTasks = projectTasksForProject(tasks, childId);
    const hasNestedProjects = childNode.children.length > 0;
    const hasContent = childDirectTasks.length > 0 || hasNestedProjects;
    if (hasContent) {
      keys.add(`project:${childId}`);
      for (const key of collectProjectTaskExpandKeys(childId, childNode, tasks)) {
        keys.add(key);
      }
    }
  }

  return keys;
}

function ProjectTaskProgress({
  status,
  percentComplete,
}: {
  status: TaskStatus;
  percentComplete: number;
}) {
  return (
    <span className="task-done-toggle task-done-toggle--static" aria-hidden="true">
      <TaskProgressIndicator status={status} percentComplete={percentComplete} />
    </span>
  );
}

interface ProjectTasksContentProps {
  projectId: string;
  projectNode: ProjectTreeNode | null;
  tasks: Task[];
  onOpenTask: (taskId: string, path: string[], projectId: string) => void;
  expanded: Set<string>;
  onToggleExpand: (key: string) => void;
}

function SubtaskRows({
  taskId,
  projectId,
  subtasks,
  parentPath,
  onOpenTask,
  expanded,
  onToggleExpand,
}: {
  taskId: string;
  projectId: string;
  subtasks: Subtask[];
  parentPath: string[];
  onOpenTask: (taskId: string, path: string[], projectId: string) => void;
  expanded: Set<string>;
  onToggleExpand: (key: string) => void;
}) {
  return (
    <>
      {subtasks.map((subtask) => {
        const path = buildSubtaskPath(parentPath, subtask._id);
        const key = nodeKey(taskId, path);
        const hasChildren = subtask.subtasks.length > 0;
        const isExpanded = expanded.has(key);

        return (
          <li key={key} className="project-task-item">
            <div className="project-task-row">
              {hasChildren ? (
                <button
                  type="button"
                  className={`task-tree-chevron${isExpanded ? ' expanded' : ''}`}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleExpand(key);
                  }}
                >
                  ›
                </button>
              ) : (
                <span className="task-tree-chevron-spacer" aria-hidden="true" />
              )}
              <ProjectTaskProgress status={subtask.status} percentComplete={subtask.percentComplete} />
              <button
                type="button"
                className="project-task-title"
                onClick={() => onOpenTask(taskId, path, projectId)}
              >
                {subtask.title}
              </button>
            </div>
            {hasChildren && isExpanded && (
              <ul className="project-tasks-children">
                <SubtaskRows
                  taskId={taskId}
                  projectId={projectId}
                  subtasks={subtask.subtasks}
                  parentPath={path}
                  onOpenTask={onOpenTask}
                  expanded={expanded}
                  onToggleExpand={onToggleExpand}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

function ProjectTasksContent({
  projectId,
  projectNode,
  tasks,
  onOpenTask,
  expanded,
  onToggleExpand,
}: ProjectTasksContentProps) {
  const directTasks = projectTasksForProject(tasks, projectId);
  const childProjects = projectNode?.children ?? [];

  return (
    <>
      {directTasks.map((task) => {
        const key = nodeKey(task._id, []);
        const hasChildren = task.subtasks.length > 0;
        const isExpanded = expanded.has(key);

        return (
          <li key={task._id} className="project-task-item">
            <div className="project-task-row">
              {hasChildren ? (
                <button
                  type="button"
                  className={`task-tree-chevron${isExpanded ? ' expanded' : ''}`}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleExpand(key);
                  }}
                >
                  ›
                </button>
              ) : (
                <span className="task-tree-chevron-spacer" aria-hidden="true" />
              )}
              <ProjectTaskProgress status={task.status} percentComplete={task.percentComplete} />
              <button
                type="button"
                className="project-task-title"
                onClick={() => onOpenTask(task._id, [], projectId)}
              >
                {task.title}
              </button>
            </div>
            {hasChildren && isExpanded && (
              <ul className="project-tasks-children">
                <SubtaskRows
                  taskId={task._id}
                  projectId={projectId}
                  subtasks={task.subtasks}
                  parentPath={[]}
                  onOpenTask={onOpenTask}
                  expanded={expanded}
                  onToggleExpand={onToggleExpand}
                />
              </ul>
            )}
          </li>
        );
      })}
      {childProjects.map((childNode) => {
        const childId = childNode.project._id;
        const childDirectTasks = projectTasksForProject(tasks, childId);
        const hasNestedProjects = childNode.children.length > 0;
        const hasContent = childDirectTasks.length > 0 || hasNestedProjects;
        const key = `project:${childId}`;
        const isExpanded = expanded.has(key);

        return (
          <li key={childId} className="project-task-item">
            <div className="project-task-row project-task-row--project">
              {hasContent ? (
                <button
                  type="button"
                  className={`task-tree-chevron${isExpanded ? ' expanded' : ''}`}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  onClick={() => onToggleExpand(key)}
                >
                  ›
                </button>
              ) : (
                <span className="task-tree-chevron-spacer" aria-hidden="true" />
              )}
              <span className="project-task-title project-task-title--project">{childNode.project.name}</span>
            </div>
            {hasContent && isExpanded && (
              <ul className="project-tasks-children">
                <ProjectTasksContent
                  projectId={childId}
                  projectNode={childNode}
                  tasks={tasks}
                  onOpenTask={onOpenTask}
                  expanded={expanded}
                  onToggleExpand={onToggleExpand}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

export function ProjectTasksList({
  projectId,
  projects,
  tasks,
  canEdit,
  onOpenTask,
  onAddTask,
}: ProjectTasksListProps) {
  const [sectionOpen, setSectionOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const projectNode = useMemo(() => {
    const tree = buildProjectTree(projects);
    return findProjectNode(tree, projectId);
  }, [projects, projectId]);

  const allExpandKeys = useMemo(
    () => collectProjectTaskExpandKeys(projectId, projectNode, tasks),
    [projectId, projectNode, tasks]
  );

  useEffect(() => {
    setExpanded(new Set(allExpandKeys));
  }, [projectId]);

  useEffect(() => {
    setExpanded((current) => {
      let changed = false;
      const next = new Set(current);
      for (const key of allExpandKeys) {
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [allExpandKeys]);

  const toggleExpand = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <details
      className="task-form-tracking-section"
      open={sectionOpen}
      onToggle={(event) => setSectionOpen(event.currentTarget.open)}
    >
      <summary className="task-form-tracking-summary">
        <span className={`project-toolbar-chevron${sectionOpen ? ' expanded' : ''}`} aria-hidden="true">
          ›
        </span>
        Tasks
      </summary>
      <div className="task-form-tracking-body">
        <div className="project-tasks-editor">
          <button
            type="button"
            className="primary-button task-steps-add"
            onClick={() => onAddTask(projectId)}
            disabled={!canEdit}
          >
            + Add Task
          </button>
          <ul className="task-steps-list project-tasks-list">
            <ProjectTasksContent
              projectId={projectId}
              projectNode={projectNode}
              tasks={tasks}
              onOpenTask={onOpenTask}
              expanded={expanded}
              onToggleExpand={toggleExpand}
            />
          </ul>
        </div>
      </div>
    </details>
  );
}
