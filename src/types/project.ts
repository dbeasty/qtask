import type { TaskStatus } from './task.js';

export type ProjectStatus = TaskStatus;

export const COLLABORATOR_ROLES = ['editor', 'executor', 'viewer'] as const;
export type CollaboratorRole = (typeof COLLABORATOR_ROLES)[number];

export const PROJECT_ROLES = ['owner', ...COLLABORATOR_ROLES] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  executor: 2,
  editor: 3,
  owner: 4,
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

export interface SerializedProject {
  _id: string;
  userId: string;
  ownerEmail: string;
  ownerDisplayName?: string;
  name: string;
  description?: string;
  parentId?: string | null;
  sortOrder: number;
  status: ProjectStatus;
  percentComplete: number;
  progressShare?: number;
  role: ProjectRole;
  canEdit: boolean;
  canUpdateStatus: boolean;
  canManageMembers: boolean;
  collaborators: SerializedCollaborator[];
  createdAt: string;
  updatedAt: string;
}
