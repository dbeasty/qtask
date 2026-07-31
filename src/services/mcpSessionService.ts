import { McpSessionModel } from '../models/index.js';
import type { PendingProposal } from '../types/conversation.js';
import { HttpError } from '../utils/httpError.js';
import { stagingService } from './stagingService.js';
import { executeTool, validateToolProposal } from '../agent/tools.js';
import { createProposal, stageCreateTool } from '../agent/stageCreateProposal.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcpSession');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_REUSE_WINDOW_MS = 60 * 60 * 1000;

export interface PendingProposalWithSession extends PendingProposal {
  sessionId: string;
}

interface ResolvedPendingProposal {
  ownerSessionId: string;
  proposal: PendingProposal;
  proposals: PendingProposal[];
}

export class McpSessionService {
  async createSession(userId: string, keyId: string, sessionId?: string): Promise<string> {
    const doc = await McpSessionModel.create({
      ...(sessionId ? { _id: sessionId } : {}),
      userId,
      keyId,
      pendingProposals: [],
    });
    return String(doc._id);
  }

  async getSession(userId: string, sessionId: string) {
    return McpSessionModel.findOne({ _id: sessionId, userId }).lean();
  }

  async getSessionByKey(userId: string, keyId: string, sessionId: string) {
    return McpSessionModel.findOne({ _id: sessionId, userId, keyId }).lean();
  }

  async touchSession(userId: string, sessionId: string): Promise<void> {
    await McpSessionModel.updateOne({ _id: sessionId, userId }, { $set: { updatedAt: new Date() } });
  }

  async setActiveProject(userId: string, sessionId: string, projectId: string): Promise<void> {
    const { projectService } = await import('./projectService.js');
    await projectService.assertProjectAccess(userId, projectId, 'viewer');
    const updated = await McpSessionModel.findOneAndUpdate(
      { _id: sessionId, userId },
      { $set: { activeProjectId: projectId } },
      { new: true }
    ).lean();
    if (!updated) {
      throw new HttpError(404, 'MCP session not found');
    }
  }

  async findReusableMongoSession(
    userId: string,
    keyId: string,
    reuseWindowMs: number = SESSION_REUSE_WINDOW_MS
  ): Promise<string | undefined> {
    const cutoff = new Date(Date.now() - reuseWindowMs);
    const sessions = await McpSessionModel.find({
      userId,
      keyId,
      updatedAt: { $gte: cutoff },
    })
      .sort({ updatedAt: -1 })
      .lean();

    if (sessions.length === 0) return undefined;

    const withPending = sessions.filter((session) =>
      (session.pendingProposals ?? []).some((proposal) => proposal.status === 'pending')
    );
    const chosen = withPending[0] ?? sessions[0];
    return chosen ? String(chosen._id) : undefined;
  }

  async getPendingProposals(userId: string, keyId: string): Promise<PendingProposalWithSession[]> {
    const sessions = await McpSessionModel.find({ userId, keyId })
      .select('pendingProposals')
      .lean();

    const pending: PendingProposalWithSession[] = [];
    for (const session of sessions) {
      const sessionId = String(session._id);
      for (const proposal of (session.pendingProposals ?? []) as PendingProposal[]) {
        if (proposal.status === 'pending') {
          pending.push({ ...proposal, sessionId });
        }
      }
    }
    return pending;
  }

  private async findPendingProposal(
    userId: string,
    keyId: string,
    proposalId: string
  ): Promise<ResolvedPendingProposal> {
    const session = await McpSessionModel.findOne({
      userId,
      keyId,
      'pendingProposals.id': proposalId,
    }).lean();

    if (!session) {
      throw new HttpError(404, 'Proposal not found or already resolved');
    }

    const proposals = [...((session.pendingProposals ?? []) as PendingProposal[])];
    const proposal = proposals.find((p) => p.id === proposalId && p.status === 'pending');
    if (!proposal) {
      throw new HttpError(404, 'Proposal not found or already resolved');
    }

    return {
      ownerSessionId: String(session._id),
      proposal,
      proposals,
    };
  }

  private async saveProposals(
    userId: string,
    sessionId: string,
    proposals: PendingProposal[]
  ): Promise<void> {
    const updated = await McpSessionModel.findOneAndUpdate(
      { _id: sessionId, userId },
      { $set: { pendingProposals: proposals } },
      { new: true }
    );
    if (!updated) {
      throw new HttpError(404, 'MCP session not found');
    }
  }

  async stageWriteTool(
    userId: string,
    sessionId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<{ proposal: PendingProposal; text: string }> {
    const session = await this.getSession(userId, sessionId);
    if (!session) {
      throw new HttpError(404, 'MCP session not found');
    }

    const proposals = [...(session.pendingProposals ?? [])];

    if (name === 'create_task' || name === 'create_project') {
      const staged = await stageCreateTool(
        userId,
        sessionId,
        name,
        args,
        'manual',
        proposals
      );
      if (!staged.proposal) {
        throw new HttpError(400, staged.result.text);
      }

      if (staged.isNew) {
        proposals.push(staged.proposal);
        await this.saveProposals(userId, sessionId, proposals);
      }

      return {
        proposal: staged.proposal,
        text: formatStagedResult(staged.proposal, staged.result.text),
      };
    }

    const validation = validateToolProposal(name, args);
    if (!validation.success) {
      throw new HttpError(400, validation.error);
    }

    const proposal = createProposal(name, validation.data, 'manual');
    proposals.push(proposal);
    await this.saveProposals(userId, sessionId, proposals);

    return {
      proposal,
      text: formatPendingProposal(proposal),
    };
  }

  async approveProposal(
    userId: string,
    keyId: string,
    proposalId: string,
    requestSessionId?: string
  ): Promise<string> {
    const { ownerSessionId, proposal, proposals } = await this.findPendingProposal(
      userId,
      keyId,
      proposalId
    );

    if (requestSessionId && requestSessionId !== ownerSessionId) {
      log.warn('MCP proposal resolved across sessions', {
        userId,
        keyId,
        proposalId,
        requestSessionId,
        ownerSessionId,
      });
    }

    log.info('MCP proposal approved', {
      userId,
      sessionId: ownerSessionId,
      proposalId,
      tool: proposal.name,
    });

    let resultText: string;
    if (proposal.stagedEntity) {
      resultText = await stagingService.commitProposal(userId, ownerSessionId, proposal);
    } else {
      const validation = validateToolProposal(proposal.name, proposal.arguments);
      if (!validation.success) {
        throw new HttpError(400, validation.error);
      }
      const result = await executeTool(proposal.name, validation.data, userId, { source: 'agent' });
      if (!result.success) {
        throw new HttpError(400, result.text);
      }
      resultText = result.text;
    }

    proposal.status = 'approved';
    await this.saveProposals(userId, ownerSessionId, proposals);
    return resultText;
  }

  async rejectProposal(
    userId: string,
    keyId: string,
    proposalId: string,
    requestSessionId?: string
  ): Promise<string> {
    const { ownerSessionId, proposal, proposals } = await this.findPendingProposal(
      userId,
      keyId,
      proposalId
    );

    if (requestSessionId && requestSessionId !== ownerSessionId) {
      log.warn('MCP proposal resolved across sessions', {
        userId,
        keyId,
        proposalId,
        requestSessionId,
        ownerSessionId,
      });
    }

    log.info('MCP proposal rejected', {
      userId,
      sessionId: ownerSessionId,
      proposalId,
      tool: proposal.name,
    });

    let resultText: string;
    if (proposal.stagedEntity) {
      resultText = await stagingService.rollbackProposal(userId, ownerSessionId, proposal);
    } else {
      resultText = `Proposal ${proposalId} for ${proposal.name} discarded`;
    }

    proposal.status = 'rejected';
    await this.saveProposals(userId, ownerSessionId, proposals);
    return resultText;
  }

  async closeSession(userId: string, sessionId: string): Promise<void> {
    await stagingService.rollbackStaleForConversation(userId, sessionId);
    await McpSessionModel.deleteOne({ _id: sessionId, userId });
  }

  async sweepExpiredSessions(): Promise<number> {
    const cutoff = new Date(Date.now() - SESSION_TTL_MS);
    const stale = await McpSessionModel.find({ updatedAt: { $lt: cutoff } }).select('_id userId').lean();
    for (const session of stale) {
      await this.closeSession(session.userId, String(session._id));
    }
    return stale.length;
  }
}

function formatStagedResult(proposal: PendingProposal, resultText: string): string {
  return JSON.stringify(
    {
      proposalId: proposal.id,
      status: 'pending',
      tool: proposal.name,
      staged: true,
      stagedEntity: proposal.stagedEntity,
      preview: tryParseJson(resultText),
      message:
        'Staged successfully. Summarize the change for the user and call approve_proposal after they confirm, or reject_proposal if they decline.',
    },
    null,
    2
  );
}

function formatPendingProposal(proposal: PendingProposal): string {
  return JSON.stringify(
    {
      proposalId: proposal.id,
      status: 'pending',
      tool: proposal.name,
      arguments: proposal.arguments,
      message:
        'Proposal staged. Summarize the change for the user and call approve_proposal after they confirm, or reject_proposal if they decline.',
    },
    null,
    2
  );
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text.split('\n\nSTAGED:')[0] ?? text);
  } catch {
    return text;
  }
}

export const mcpSessionService = new McpSessionService();
