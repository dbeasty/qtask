import crypto from 'node:crypto';
import { InviteModel, ProjectModel, UserModel } from '../models/index.js';
import { HttpError } from '../utils/httpError.js';
import {
  isCollaboratorRole,
  type CollaboratorRole,
} from '../types/project.js';
import { projectService } from './projectService.js';
import {
  sendProjectInviteEmail,
  sendProjectShareAcceptedEmail,
  sendProjectShareDeclinedEmail,
} from './emailService.js';
import { notificationService } from './notificationService.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type SerializedInvite = {
  _id: string;
  projectId: string;
  projectName: string;
  inviterUserId: string;
  inviterEmail: string;
  inviterDisplayName?: string;
  inviteeEmail: string;
  inviteeUserId?: string;
  role: CollaboratorRole;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  token: string;
  expiresAt: string;
  respondedAt?: string;
  createdAt: string;
};

type LeanInvite = {
  _id: unknown;
  projectId: string;
  inviterUserId: string;
  inviteeEmail: string;
  inviteeUserId?: string;
  role: CollaboratorRole;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  token: string;
  expiresAt: Date;
  respondedAt?: Date;
  createdAt: Date;
};

async function serializeInvite(invite: LeanInvite): Promise<SerializedInvite> {
  const [project, inviter] = await Promise.all([
    ProjectModel.findById(invite.projectId).select('name').lean(),
    UserModel.findById(invite.inviterUserId).select('email displayName').lean(),
  ]);

  return {
    _id: String(invite._id),
    projectId: invite.projectId,
    projectName: project?.name ?? 'Unknown project',
    inviterUserId: invite.inviterUserId,
    inviterEmail: inviter?.email ?? 'unknown',
    inviterDisplayName: inviter?.displayName ?? undefined,
    inviteeEmail: invite.inviteeEmail,
    inviteeUserId: invite.inviteeUserId,
    role: invite.role,
    status: invite.status,
    token: invite.token,
    expiresAt: invite.expiresAt.toISOString(),
    respondedAt: invite.respondedAt?.toISOString(),
    createdAt: invite.createdAt.toISOString(),
  };
}

async function expireStaleInvites(): Promise<void> {
  await InviteModel.updateMany(
    { status: 'pending', expiresAt: { $lt: new Date() } },
    { $set: { status: 'expired', respondedAt: new Date() } }
  );
}

export class InviteService {
  async createInvite(
    userId: string,
    projectId: string,
    input: { email?: string; userId?: string; role?: CollaboratorRole }
  ): Promise<SerializedInvite> {
    await projectService.assertProjectAccess(userId, projectId, 'owner');

    const role: CollaboratorRole = input.role ?? 'editor';
    if (!isCollaboratorRole(role)) {
      throw new HttpError(400, 'Invalid collaborator role');
    }

    let targetUser: { _id: unknown; email: string; displayName?: string | null } | null = null;
    if (input.userId) {
      targetUser = await UserModel.findById(input.userId).select('email displayName').lean();
    } else if (input.email) {
      targetUser = await UserModel.findOne({ email: normalizeEmail(input.email) })
        .select('email displayName')
        .lean();
    } else {
      throw new HttpError(400, 'email or userId is required');
    }

    if (!targetUser) {
      throw new HttpError(404, 'User not found');
    }

    const targetId = String(targetUser._id);
    const project = await ProjectModel.findById(projectId).lean();
    if (!project) {
      throw new HttpError(404, 'Project not found');
    }

    if (project.userId === targetId) {
      throw new HttpError(400, 'Project owner is already a member');
    }

    const existingCollab = (project.collaborators ?? []).find((c) => c.userId === targetId);
    if (existingCollab) {
      throw new HttpError(409, 'User is already a collaborator');
    }

    await expireStaleInvites();

    const inviteeEmail = normalizeEmail(targetUser.email);
    const pending = await InviteModel.findOne({
      projectId,
      inviteeEmail,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }).lean();
    if (pending) {
      throw new HttpError(409, 'A pending invite already exists for this user');
    }

    const inviter = await UserModel.findById(userId).select('email displayName').lean();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = await InviteModel.create({
      projectId,
      inviterUserId: userId,
      inviteeEmail,
      inviteeUserId: targetId,
      role,
      status: 'pending',
      token,
      expiresAt,
    });

    await sendProjectInviteEmail({
      to: inviteeEmail,
      token,
      projectName: project.name,
      inviterName: inviter?.displayName || inviter?.email || 'Someone',
      role,
    });

    await notificationService.createNotification(targetId, 'project_invite', {
      projectId,
      projectName: project.name,
      inviterEmail: inviter?.email ?? 'unknown',
      inviterDisplayName: inviter?.displayName ?? undefined,
      role,
      inviteId: String(invite._id),
    });

    return serializeInvite(invite.toObject() as LeanInvite);
  }

  async listInvitesForUser(userId: string, status: 'pending' | 'all' = 'pending') {
    await expireStaleInvites();
    const user = await UserModel.findById(userId).select('email').lean();
    if (!user) {
      throw new HttpError(404, 'User not found');
    }

    const query: Record<string, unknown> = {
      $or: [{ inviteeUserId: userId }, { inviteeEmail: normalizeEmail(user.email) }],
    };
    if (status === 'pending') {
      query.status = 'pending';
      query.expiresAt = { $gt: new Date() };
    }

    const invites = await InviteModel.find(query).sort({ createdAt: -1 }).lean();
    return Promise.all(invites.map((invite) => serializeInvite(invite as LeanInvite)));
  }

  async listInvitesForProject(userId: string, projectId: string) {
    await projectService.assertProjectAccess(userId, projectId, 'owner');
    await expireStaleInvites();
    const invites = await InviteModel.find({ projectId, status: 'pending', expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .lean();
    return Promise.all(invites.map((invite) => serializeInvite(invite as LeanInvite)));
  }

  async getInvitePreview(token: string) {
    await expireStaleInvites();
    const invite = await InviteModel.findOne({ token }).lean();
    if (!invite || invite.status !== 'pending' || invite.expiresAt <= new Date()) {
      throw new HttpError(404, 'Invite not found or expired');
    }
    return serializeInvite(invite as LeanInvite);
  }

  async acceptInvite(userId: string, inviteId: string) {
    await expireStaleInvites();
    const invite = await InviteModel.findById(inviteId);
    if (!invite || invite.status !== 'pending' || invite.expiresAt <= new Date()) {
      throw new HttpError(404, 'Invite not found or expired');
    }

    const user = await UserModel.findById(userId).select('email displayName').lean();
    if (!user) {
      throw new HttpError(404, 'User not found');
    }

    const userEmail = normalizeEmail(user.email);
    if (invite.inviteeUserId && invite.inviteeUserId !== userId) {
      throw new HttpError(403, 'This invite is for a different user');
    }
    if (normalizeEmail(invite.inviteeEmail) !== userEmail) {
      throw new HttpError(403, 'This invite is for a different email address');
    }

    await projectService.grantCollaboratorAccess(String(invite.projectId), userId, invite.role);

    invite.status = 'accepted';
    invite.inviteeUserId = userId;
    invite.respondedAt = new Date();
    await invite.save();

    const project = await ProjectModel.findById(invite.projectId).select('name userId').lean();
    const inviter = await UserModel.findById(invite.inviterUserId).select('email').lean();

    if (project && inviter?.email) {
      await sendProjectShareAcceptedEmail({
        to: inviter.email,
        projectName: project.name,
        inviteeEmail: user.email,
        inviteeDisplayName: user.displayName ?? undefined,
      });
    }

    await notificationService.createNotification(invite.inviterUserId, 'project_share_accepted', {
      projectId: invite.projectId,
      projectName: project?.name ?? 'Unknown project',
      inviteeEmail: user.email,
      inviteeDisplayName: user.displayName ?? undefined,
      role: invite.role,
      inviteId: String(invite._id),
    });

    const accessProject = await projectService.getProject(userId, String(invite.projectId));
    return {
      invite: await serializeInvite(invite.toObject() as LeanInvite),
      project: accessProject,
    };
  }

  async acceptInviteByToken(userId: string, token: string) {
    const invite = await InviteModel.findOne({ token }).lean();
    if (!invite) {
      throw new HttpError(404, 'Invite not found');
    }
    return this.acceptInvite(userId, String(invite._id));
  }

  async declineInvite(userId: string, inviteId: string) {
    await expireStaleInvites();
    const invite = await InviteModel.findById(inviteId);
    if (!invite || invite.status !== 'pending' || invite.expiresAt <= new Date()) {
      throw new HttpError(404, 'Invite not found or expired');
    }

    const user = await UserModel.findById(userId).select('email displayName').lean();
    if (!user) {
      throw new HttpError(404, 'User not found');
    }

    if (invite.inviteeUserId && invite.inviteeUserId !== userId) {
      throw new HttpError(403, 'This invite is for a different user');
    }
    if (normalizeEmail(invite.inviteeEmail) !== normalizeEmail(user.email)) {
      throw new HttpError(403, 'This invite is for a different email address');
    }

    invite.status = 'declined';
    invite.inviteeUserId = userId;
    invite.respondedAt = new Date();
    await invite.save();

    const project = await ProjectModel.findById(invite.projectId).select('name').lean();
    const inviter = await UserModel.findById(invite.inviterUserId).select('email').lean();

    if (project && inviter?.email) {
      await sendProjectShareDeclinedEmail({
        to: inviter.email,
        projectName: project.name,
        inviteeEmail: user.email,
        inviteeDisplayName: user.displayName ?? undefined,
      });
    }

    await notificationService.createNotification(invite.inviterUserId, 'project_share_declined', {
      projectId: invite.projectId,
      projectName: project?.name ?? 'Unknown project',
      inviteeEmail: user.email,
      inviteeDisplayName: user.displayName ?? undefined,
      role: invite.role,
      inviteId: String(invite._id),
    });

    return serializeInvite(invite.toObject() as LeanInvite);
  }

  async cancelInvite(userId: string, projectId: string, inviteId: string) {
    await projectService.assertProjectAccess(userId, projectId, 'owner');
    const invite = await InviteModel.findOne({ _id: inviteId, projectId, status: 'pending' });
    if (!invite) {
      throw new HttpError(404, 'Pending invite not found');
    }
    invite.status = 'expired';
    invite.respondedAt = new Date();
    await invite.save();
    return serializeInvite(invite.toObject() as LeanInvite);
  }
}

export const inviteService = new InviteService();
