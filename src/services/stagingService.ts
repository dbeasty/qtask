import {
  ConversationModel,
  ProjectModel,
  TaskModel,
} from '../models/index.js';
import type { PendingProposal } from '../types/conversation.js';
import { createLogger } from '../utils/logger.js';
import { logActivity } from './activityService.js';
import { enqueueEmbeddingJob } from './embeddingQueue.js';

const log = createLogger('stagingService');
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

let sweepTimer: NodeJS.Timeout | null = null;

async function setProposalStatuses(
  userId: string,
  conversationId: string,
  proposalIds: string[],
  status: PendingProposal['status']
) {
  if (proposalIds.length === 0) return;
  const conversation = await ConversationModel.findOne({ _id: conversationId, userId });
  if (!conversation) return;

  const ids = new Set(proposalIds);
  const proposals = (conversation.pendingProposals ?? []) as PendingProposal[];
  let changed = false;
  for (const proposal of proposals) {
    if (ids.has(proposal.id) && proposal.status === 'pending') {
      proposal.status = status;
      changed = true;
    }
  }
  if (changed) {
    conversation.markModified('pendingProposals');
    await conversation.save();
  }
}

export class StagingService {
  async commitProposal(
    userId: string,
    conversationId: string,
    proposal: PendingProposal
  ): Promise<string> {
    const entity = proposal.stagedEntity;
    if (!entity) throw new Error('Proposal has no staged entity');

    if (entity.kind === 'project') {
      const result = await ProjectModel.updateOne(
        {
          _id: entity.id,
          userId,
          'staging.conversationId': conversationId,
          'staging.proposalId': proposal.id,
        },
        { $unset: { staging: 1 } }
      );
      if (result.matchedCount === 0) {
        throw new Error('Staged project no longer exists');
      }
      const { projectService } = await import('./projectService.js');
      await projectService.recalculateProjectAndAncestors(entity.id);
      return `Project ${entity.id} committed`;
    }

    const task = await TaskModel.findOne({
      _id: entity.id,
      userId,
      'staging.conversationId': conversationId,
      'staging.proposalId': proposal.id,
    }).lean();
    if (!task) throw new Error('Staged task no longer exists');

    if (task.projectId || (Array.isArray(task.projectIds) && task.projectIds.length > 0)) {
      const parentIds = [
        ...(Array.isArray(task.projectIds) ? task.projectIds.map(String) : []),
        ...(task.projectId ? [String(task.projectId)] : []),
      ];
      for (const parentId of [...new Set(parentIds)]) {
        const parent = await ProjectModel.findOne({
          _id: parentId,
          userId,
          'staging.conversationId': conversationId,
        })
          .select('staging.proposalId')
          .lean();
        if (parent?.staging?.proposalId) {
          await ProjectModel.updateOne({ _id: parent._id }, { $unset: { staging: 1 } });
          await setProposalStatuses(
            userId,
            conversationId,
            [parent.staging.proposalId],
            'approved'
          );
          break;
        }
      }
    }

    const result = await TaskModel.updateOne(
      {
        _id: entity.id,
        userId,
        'staging.conversationId': conversationId,
        'staging.proposalId': proposal.id,
      },
      { $unset: { staging: 1 } }
    );
    if (result.matchedCount === 0) throw new Error('Staged task no longer exists');

    await enqueueEmbeddingJob(entity.id);
    await logActivity({
      taskId: entity.id,
      userId,
      action: 'task.created',
      details: { title: task.title },
      source: 'ai',
    });

    const { projectService } = await import('./projectService.js');
    const projectIds = [
      ...(Array.isArray(task.projectIds) ? task.projectIds.map(String) : []),
      ...(task.projectId ? [String(task.projectId)] : []),
    ];
    await projectService.recalculateProjects(projectIds);

    return `Task ${entity.id} committed`;
  }

  async rollbackProposal(
    userId: string,
    conversationId: string,
    proposal: PendingProposal
  ): Promise<string> {
    const entity = proposal.stagedEntity;
    if (!entity) throw new Error('Proposal has no staged entity');

    if (entity.kind === 'task') {
      await TaskModel.deleteOne({
        _id: entity.id,
        userId,
        'staging.conversationId': conversationId,
        'staging.proposalId': proposal.id,
      });
      return `Staged task ${entity.id} discarded`;
    }

    const children = await TaskModel.find({
      userId,
      $or: [{ projectIds: entity.id }, { projectId: entity.id }],
      'staging.conversationId': conversationId,
    })
      .select('staging.proposalId')
      .lean();
    const childProposalIds = children
      .map((task) => task.staging?.proposalId)
      .filter((id): id is string => Boolean(id));

    await TaskModel.deleteMany({
      userId,
      $or: [{ projectIds: entity.id }, { projectId: entity.id }],
      'staging.conversationId': conversationId,
    });
    await ProjectModel.deleteOne({
      _id: entity.id,
      userId,
      'staging.conversationId': conversationId,
      'staging.proposalId': proposal.id,
    });
    await setProposalStatuses(userId, conversationId, childProposalIds, 'expired');
    return `Staged project ${entity.id} and its staged tasks discarded`;
  }

  async rollbackStaleForConversation(userId: string, conversationId: string): Promise<number> {
    const [tasks, projects] = await Promise.all([
      TaskModel.find({ userId, 'staging.conversationId': conversationId })
        .select('staging.proposalId')
        .lean(),
      ProjectModel.find({ userId, 'staging.conversationId': conversationId })
        .select('staging.proposalId')
        .lean(),
    ]);
    const proposalIds = [...tasks, ...projects]
      .map((doc) => doc.staging?.proposalId)
      .filter((id): id is string => Boolean(id));

    await TaskModel.deleteMany({ userId, 'staging.conversationId': conversationId });
    await ProjectModel.deleteMany({ userId, 'staging.conversationId': conversationId });
    await setProposalStatuses(userId, conversationId, proposalIds, 'expired');
    return tasks.length + projects.length;
  }

  async sweepExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - STAGING_TTL_MS);
    const [tasks, projects] = await Promise.all([
      TaskModel.find({ 'staging.stagedAt': { $lt: cutoff } }).select('userId staging').lean(),
      ProjectModel.find({ 'staging.stagedAt': { $lt: cutoff } }).select('userId staging').lean(),
    ]);

    const conversations = new Map<string, { userId: string; conversationId: string }>();
    for (const doc of [...tasks, ...projects]) {
      if (doc.staging?.conversationId) {
        conversations.set(`${doc.userId}:${doc.staging.conversationId}`, {
          userId: doc.userId,
          conversationId: doc.staging.conversationId,
        });
      }
    }

    let removed = 0;
    for (const entry of conversations.values()) {
      removed += await this.rollbackStaleForConversation(entry.userId, entry.conversationId);
    }
    if (removed > 0) log.info('Expired staged entities removed', { count: removed });
    return removed;
  }

  startSweep() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      this.sweepExpired().catch((error) => {
        log.error('Staging sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }

  stopSweep() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export const stagingService = new StagingService();
