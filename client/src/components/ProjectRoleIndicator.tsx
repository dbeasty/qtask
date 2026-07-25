import type { ProjectRole } from '../types';

const MANAGER_TOOLTIP =
  'Manager — you can create and edit this project, but cannot delete it or manage members';

interface ProjectRoleIndicatorProps {
  role: ProjectRole;
  className?: string;
}

export function ProjectRoleIndicator({ role, className }: ProjectRoleIndicatorProps) {
  if (role !== 'manager') return null;

  return (
    <span
      className={`project-role-indicator${className ? ` ${className}` : ''}`}
      title={MANAGER_TOOLTIP}
      aria-label={MANAGER_TOOLTIP}
    />
  );
}

export function projectTreeRoleClass(role: ProjectRole): string {
  return role === 'manager' ? 'project-tree-item--manager' : '';
}
