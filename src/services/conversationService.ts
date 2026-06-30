import { ConversationModel } from '../models/index.js';
import type {
  Conversation,
  ConversationSummary,
  PausedBatchState,
  PendingProposal,
  StoredMessage,
} from '../types/conversation.js';

function toSummary(doc: {
  _id: unknown;
  userId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}): ConversationSummary {
  return {
    _id: String(doc._id),
    userId: doc.userId,
    title: doc.title,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toConversation(doc: {
  _id: unknown;
  userId: string;
  title: string;
  messages: Array<{
    role: StoredMessage['role'];
    content: string;
    toolCalls?: StoredMessage['toolCalls'];
    toolName?: string | null;
  }>;
  pendingProposals?: PendingProposal[];
  pausedBatch?: PausedBatchState | null;
  createdAt: Date;
  updatedAt: Date;
}): Conversation {
  return {
    ...toSummary(doc),
    messages: doc.messages.map((message) => ({
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls,
      toolName: message.toolName ?? undefined,
    })),
    pendingProposals: doc.pendingProposals ?? [],
    pausedBatch: doc.pausedBatch ?? null,
  };
}

export class ConversationService {
  async createConversation(userId: string, title = 'New conversation'): Promise<Conversation> {
    const doc = await ConversationModel.create({
      userId,
      title,
      messages: [],
      pendingProposals: [],
      pausedBatch: null,
    });
    return toConversation(doc.toObject() as Parameters<typeof toConversation>[0]);
  }

  async getConversation(userId: string, conversationId: string): Promise<Conversation | null> {
    const doc = await ConversationModel.findOne({ _id: conversationId, userId }).lean();
    if (!doc) return null;
    return toConversation(doc as Parameters<typeof toConversation>[0]);
  }

  async listConversations(userId: string): Promise<ConversationSummary[]> {
    const docs = await ConversationModel.find({ userId }).sort({ updatedAt: -1 }).lean();
    return docs.map((doc) => toSummary(doc as Parameters<typeof toSummary>[0]));
  }

  async appendMessages(
    userId: string,
    conversationId: string,
    messages: StoredMessage[],
    title?: string
  ): Promise<Conversation | null> {
    const update: Record<string, unknown> = {
      $push: { messages: { $each: messages } },
    };
    if (title) {
      update.$set = { title };
    }

    const doc = await ConversationModel.findOneAndUpdate(
      { _id: conversationId, userId },
      update,
      { new: true }
    ).lean();

    if (!doc) return null;
    return toConversation(doc as Parameters<typeof toConversation>[0]);
  }

  async setMessages(
    userId: string,
    conversationId: string,
    messages: StoredMessage[],
    title?: string
  ): Promise<Conversation | null> {
    const update: Record<string, unknown> = { messages };
    if (title) {
      update.title = title;
    }

    const doc = await ConversationModel.findOneAndUpdate(
      { _id: conversationId, userId },
      { $set: update },
      { new: true }
    ).lean();

    if (!doc) return null;
    return toConversation(doc as Parameters<typeof toConversation>[0]);
  }

  async savePauseState(
    userId: string,
    conversationId: string,
    data: {
      messages: StoredMessage[];
      pendingProposals: PendingProposal[];
      pausedBatch?: PausedBatchState | null;
      title?: string;
    }
  ): Promise<Conversation | null> {
    const update: Record<string, unknown> = {
      messages: data.messages,
      pendingProposals: data.pendingProposals,
      pausedBatch: data.pausedBatch ?? null,
    };
    if (data.title) {
      update.title = data.title;
    }

    const doc = await ConversationModel.findOneAndUpdate(
      { _id: conversationId, userId },
      { $set: update },
      { new: true }
    ).lean();

    if (!doc) return null;
    return toConversation(doc as Parameters<typeof toConversation>[0]);
  }

  async updateProposalStatus(
    userId: string,
    conversationId: string,
    proposalId: string,
    status: 'approved' | 'rejected',
    extraMessages: StoredMessage[]
  ): Promise<Conversation | null> {
    const doc = await ConversationModel.findOne({ _id: conversationId, userId });
    if (!doc) return null;

    const proposals = (doc.pendingProposals ?? []) as PendingProposal[];
    const proposal = proposals.find((p) => p.id === proposalId);
    if (!proposal) return null;

    proposal.status = status;
    doc.messages.push(...extraMessages);
    await doc.save();

    return toConversation(doc.toObject() as Parameters<typeof toConversation>[0]);
  }

  async clearPauseState(
    userId: string,
    conversationId: string,
    messages: StoredMessage[]
  ): Promise<Conversation | null> {
    const doc = await ConversationModel.findOneAndUpdate(
      { _id: conversationId, userId },
      {
        $set: {
          messages,
          pendingProposals: [],
          pausedBatch: null,
        },
      },
      { new: true }
    ).lean();

    if (!doc) return null;
    return toConversation(doc as Parameters<typeof toConversation>[0]);
  }
}

export const conversationService = new ConversationService();
