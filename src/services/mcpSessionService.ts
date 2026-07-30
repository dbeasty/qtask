import { randomUUID } from 'node:crypto';
import { McpSessionModel } from '../models/index.js';
import type { PendingProposal } from '../types/conversation.js';
import { HttpError } from '../utils/httpError.js';
import { stagingService } from './stagingService.js';
import { executeTool, validateToolProposal } from '../agent/tools.js';
import { createProposal, stageCreateTool } from '../agent/stageCreateProposal.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcpSession');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

  async getPendingProposals(userId: string, sessionId: string): Promise<PendingProposal[]> {
    const session = await this.getSession(userId, sessionId);
    if (!session) {
      throw new HttpError(404, 'MCP session not found');
    }
    return (session.pendingProposals ?? []).filter((p) => p.status === 'pending');
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

  async approveProposal(userId: string, sessionId: string, proposalId: string): Promise<string> {
    const session = await this.getSession(userId, sessionId);
    if (!session) {
      throw new HttpError(404, 'MCP session not found');
    }

    const proposals = [...(session.pendingProposals ?? [])] as PendingProposal[];
    const proposal = proposals.find((p) => p.id === proposalId && p.status === 'pending');
    if (!proposal) {
      throw new HttpError(404, 'Proposal not found or already resolved');
    }

    log.info('MCP proposal approved', { userId, sessionId, proposalId, tool: proposal.name });

    let resultText: string;
    if (proposal.stagedEntity) {
      resultText = await stagingService.commitProposal(userId, sessionId, proposal);
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
    await this.saveProposals(userId, sessionId, proposals);
    return resultText;
  }

  async rejectProposal(userId: string, sessionId: string, proposalId: string): Promise<string> {
    const session = await this.getSession(userId, sessionId);
    if (!session) {
      throw new HttpError(404, 'MCP session not found');
    }

    const proposals = [...(session.pendingProposals ?? [])] as PendingProposal[];
    const proposal = proposals.find((p) => p.id === proposalId && p.status === 'pending');
    if (!proposal) {
      throw new HttpError(404, 'Proposal not found or already resolved');
    }

    log.info('MCP proposal rejected', { userId, sessionId, proposalId, tool: proposal.name });

    let resultText: string;
    if (proposal.stagedEntity) {
      resultText = await stagingService.rollbackProposal(userId, sessionId, proposal);
    } else {
      resultText = `Proposal ${proposalId} for ${proposal.name} discarded`;
    }

    proposal.status = 'rejected';
    await this.saveProposals(userId, sessionId, proposals);
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
