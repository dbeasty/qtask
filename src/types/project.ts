import type { TaskStatus } from './task.js';

export type ProjectStatus = TaskStatus;

export const COLLABORATOR_ROLES = ['editor', 'executor', 'viewer', 'manager'] as const;
export type CollaboratorRole = (typeof COLLABORATOR_ROLES)[number];

export const PROJECT_ROLES = ['owner', ...COLLABORATOR_ROLES] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  executor: 2,
  editor: 3,
  manager: 4,
  owner: 5,
};

export function isCollaboratorRole(role: string): role is CollaboratorRole {
  return (COLLABORATOR_ROLES as readonly string[]).includes(role);
}

export function roleAtLeast(role: ProjectRole, minimum: ProjectRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function canEditProject(role: ProjectRole): boolean {
  return roleAtLeast(role, 'editor');
}

export function canUpdateStatus(role: ProjectRole): boolean {
  return roleAtLeast(role, 'executor');
}

export function canManageMembers(role: ProjectRole): boolean {
  return role === 'owner';
}

export function canManageStructure(role: ProjectRole): boolean {
  return roleAtLeast(role, 'manager');
}

export function canDeleteProject(role: ProjectRole): boolean {
  return role === 'owner';
}

export function canDeleteOwnTasks(role: ProjectRole): boolean {
  return role === 'editor';
}

export function canDeleteTask(
  role: ProjectRole,
  taskCreatorId: string,
  userId: string
): boolean {
  if (role === 'owner') return true;
  if (role === 'editor' && taskCreatorId === userId) return true;
  return false;
}

export interface ProjectCollaborator {
  userId: string;
  role: CollaboratorRole;
}

export interface SerializedCollaborator {
  userId: string;
  email: string;
  displayName?: string;
  role: CollaboratorRole;
}

export interface ProjectTrackingRollup {
  hoursSpent: number;
  hoursRemaining: number;
  materialsTotal: number;
  laborCost: number;
  totalCost: number;
  updatedAt: string;
}

export interface SerializedProject {
  _id: string;
  userId: string;
  ownerEmail: string;
  ownerDisplayName?: string;
  name: string;
  description?: string;
  notes?: string;
  parentId?: string | null;
  sortOrder: number;
  status: ProjectStatus;
  percentComplete: number;
  progressShare?: number;
  hourlyRate?: number;
  trackingRollup?: ProjectTrackingRollup;
  role: ProjectRole;
  canEdit: boolean;
  canUpdateStatus: boolean;
  canManageMembers: boolean;
  canManageStructure: boolean;
  canDeleteProjects: boolean;
  canDeleteOwnTasks: boolean;
  collaborators: SerializedCollaborator[];
  createdAt: string;
  updatedAt: string;
}
