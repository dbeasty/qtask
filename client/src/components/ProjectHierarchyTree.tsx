import { useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { Project } from '../types';
import type { ProjectTreeNode } from '../utils/projectTree';
import { getProjectDescendantIds } from '../utils/projectTree';
import { ProjectMoveMenu } from './ProjectMoveMenu';
import { TaskProgressIndicator } from './TaskProgressIndicator';

interface ProjectHierarchyTreeProps {
  projects: Project[];
  tree: ProjectTreeNode[];
  selectionId: string | null;
  saving: boolean;
  onSelect: (projectId: string) => void;
  onMove: (projectId: string, parentId: string | null, index?: number) => void;
  onDelete: (projectId: string) => void | Promise<boolean>;
}

export function ProjectHierarchyTree({
  projects,
  tree,
  selectionId,
  saving,
  onSelect,
  onMove,
  onDelete,
}: ProjectHierarchyTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [openMoveMenuId, setOpenMoveMenuId] = useState<string | null>(null);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);

  const toggle = (projectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <ul className="task-tree project-tree">
      {tree.map((node, index) => (
        <ProjectTreeNodeView
          key={node.project._id}
          node={node}
          depth={0}
          siblingIndex={index}
          siblingCount={tree.length}
          parentId={null}
          projects={projects}
          selectionId={selectionId}
          expanded={expanded}
          saving={saving}
          openMoveMenuId={openMoveMenuId}
          moveTriggerRef={moveTriggerRef}
          onToggleMoveMenu={setOpenMoveMenuId}
          onToggle={toggle}
          onSelect={onSelect}
          onMove={onMove}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}

interface NodeProps {
  node: ProjectTreeNode;
  depth: number;
  siblingIndex: number;
  siblingCount: number;
  parentId: string | null;
  projects: Project[];
  selectionId: string | null;
  expanded: Set<string>;
  saving: boolean;
  openMoveMenuId: string | null;
  moveTriggerRef: RefObject<HTMLButtonElement | null>;
  onToggleMoveMenu: (projectId: string | null) => void;
  onToggle: (projectId: string) => void;
  onSelect: (projectId: string) => void;
  onMove: (projectId: string, parentId: string | null, index?: number) => void;
  onDelete: (projectId: string) => void | Promise<boolean>;
}

function ProjectTreeNodeView({
  node,
  depth,
  siblingIndex,
  siblingCount,
  parentId,
  projects,
  selectionId,
  expanded,
  saving,
  openMoveMenuId,
  moveTriggerRef,
  onToggleMoveMenu,
  onToggle,
  onSelect,
  onMove,
  onDelete,
}: NodeProps) {
  const { project, children } = node;
  const isActive = selectionId === project._id;
  const hasChildren = children.length > 0;
  const isExpanded =
    expanded.has(project._id) || children.some((child) => child.project._id === selectionId);
  const canManage = project.canManageMembers;
  const menuOpen = openMoveMenuId === project._id;
  const childCount = children.length;

  const nestTargets = useMemo(() => {
    if (!canManage) return [];
    const blocked = getProjectDescendantIds(projects, project._id);
    blocked.add(project._id);
    return projects
      .filter((item) => item.canManageMembers && !blocked.has(item._id))
      .map((item) => ({ id: item._id, label: item.name }));
  }, [projects, project._id, canManage]);

  return (
    <li className="task-tree-item">
      <div
        className="task-tree-node"
        style={{ '--tree-depth': depth } as CSSProperties}
      >
        <div className="task-tree-row-body">
          {hasChildren ? (
            <button
              type="button"
              className={`task-tree-chevron${isExpanded ? ' expanded' : ''}`}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              onClick={() => onToggle(project._id)}
            >
              ›
            </button>
          ) : (
            <span className="task-tree-chevron-spacer" />
          )}
          <span className="task-done-toggle task-done-toggle--static" aria-hidden="true">
            <TaskProgressIndicator
              status={project.status ?? 'todo'}
              percentComplete={project.percentComplete ?? 0}
            />
          </span>
          <button
            type="button"
            className={`task-tree-label task-list-item${isActive ? ' active' : ''}`}
            onClick={() => onSelect(project._id)}
          >
            <span className="task-tree-label-header">
              <span className="task-list-title">{project.name}</span>
            </span>
            {hasChildren && (
              <span className="task-list-meta">
                {childCount} {childCount === 1 ? 'child' : 'children'}
              </span>
            )}
          </button>
        </div>
        {isActive && canManage && (
          <div className="task-tree-move-wrap">
            <button
              type="button"
              className="task-tree-move-trigger"
              ref={menuOpen ? moveTriggerRef : undefined}
              aria-label="Move project"
              aria-expanded={menuOpen}
              onClick={() => onToggleMoveMenu(menuOpen ? null : project._id)}
            >
              ⋮
            </button>
            {menuOpen && (
              <ProjectMoveMenu
                anchorRef={moveTriggerRef}
                saving={saving}
                canMoveUp={siblingIndex > 0}
                canMoveDown={siblingIndex < siblingCount - 1}
                canMoveToRoot={Boolean(parentId)}
                nestTargets={nestTargets}
                onMoveUp={() => onMove(project._id, parentId, siblingIndex - 1)}
                onMoveDown={() => onMove(project._id, parentId, siblingIndex + 1)}
                onMoveToRoot={() => onMove(project._id, null)}
                onNestUnder={(targetId) => onMove(project._id, targetId)}
                onDelete={() => onDelete(project._id)}
                onClose={() => onToggleMoveMenu(null)}
              />
            )}
          </div>
        )}
      </div>
      {hasChildren && isExpanded && (
        <ul className="task-tree-children">
          {children.map((child, index) => (
            <ProjectTreeNodeView
              key={child.project._id}
              node={child}
              depth={depth + 1}
              siblingIndex={index}
              siblingCount={children.length}
              parentId={project._id}
              projects={projects}
              selectionId={selectionId}
              expanded={expanded}
              saving={saving}
              openMoveMenuId={openMoveMenuId}
              moveTriggerRef={moveTriggerRef}
              onToggleMoveMenu={onToggleMoveMenu}
              onToggle={onToggle}
              onSelect={onSelect}
              onMove={onMove}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
