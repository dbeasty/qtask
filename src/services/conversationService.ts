import { ConversationModel } from '../models/index.js';
import type {
  Conversation,
  ConversationSummary,
  PausedBatchState,
  PendingProposal,
  StoredMessage,
} from '../types/conversation.js';

const conversationSaveLocks = new Map<string, Promise<void>>();

/** Serializes writes to a conversation's messages/pendingProposals/
 *  pausedBatch fields, mirroring withTaskSaveLock in taskService.ts.
 *  Without it, two concurrent writes to the same conversation (e.g.
 *  approving a proposal while a chat turn is being paused) could each
 *  load their own snapshot and overwrite the other's changes. */
async function withConversationSaveLock<T>(
  conversationId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prior = conversationSaveLocks.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(
    () => gate,
    () => gate
  );
  conversationSaveLocks.set(conversationId, queued);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    void queued.finally(() => {
      if (conversationSaveLocks.get(conversationId) === queued) {
        conversationSaveLocks.delete(conversationId);
      }
    });
  }
}

function toSummary(doc: {
  _id: unknown;
  userId: string;
  projectId?: string | null;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}): ConversationSummary {
  return {
    _id: String(doc._id),
    userId: doc.userId,
    projectId: doc.projectId ? String(doc.projectId) : undefined,
    title: doc.title,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toConversation(doc: {
  _id: unknown;
  userId: string;
  projectId?: string | null;
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
  async createConversation(
    userId: string,
    title = 'New conversation',
    projectId?: string
  ): Promise<Conversation> {
    if (!projectId) {
      const { projectService } = await import('./projectService.js');
      projectId = await projectService.ensureDefaultProject(userId);
    }

    const doc = await ConversationModel.create({
      userId,
      projectId,
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

  async listConversations(userId: string, projectId?: string): Promise<ConversationSummary[]> {
    const filter: Record<string, unknown> = { userId };
    if (projectId) filter.projectId = projectId;
    // toSummary() only needs these fields — project them explicitly so
    // listing a user's conversations doesn't pull every conversation's
    // full message history (and pendingProposals/pausedBatch) into memory
    // just to build a lightweight summary list.
    const docs = await ConversationModel.find(filter)
      .select('userId projectId title createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean();
    return docs.map((doc) => toSummary(doc as Parameters<typeof toSummary>[0]));
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const result = await ConversationModel.deleteOne({ _id: conversationId, userId });
    return result.deletedCount === 1;
  }

  async resetConversation(userId: string, conversationId: string): Promise<Conversation | null> {
    const existing = await ConversationModel.findOne({ _id: conversationId, userId }).lean();
    if (!existing) return null;

    const firstUserMessage = (existing.messages ?? []).find(
      (message) => message.role === 'user' && typeof message.content === 'string'
    );
    const preservedMessages = firstUserMessage
      ? [
          {
            role: 'user' as const,
            content: firstUserMessage.content,
          },
        ]
      : [];

    const doc = await ConversationModel.findOneAndUpdate(
      { _id: conversationId, userId },
      {
        $set: {
          messages: preservedMessages,
          pendingProposals: [],
          pausedBatch: null,
        },
      },
      { new: true }
    ).lean();

    if (!doc) return null;
    return toConversation(doc as Parameters<typeof toConversation>[0]);
  }

  async duplicateConversation(
    userId: string,
    conversationId: string
  ): Promise<Conversation | null> {
    const existing = await ConversationModel.findOne({ _id: conversationId, userId }).lean();
    if (!existing) return null;

    const baseTitle = existing.title?.trim() || 'New conversation';
    const title = baseTitle.endsWith(' (copy)') ? baseTitle : `${baseTitle} (copy)`;

    const messages = (existing.messages ?? []).map((message) => ({
      role: message.role as StoredMessage['role'],
      content: message.content,
      toolCalls: message.toolCalls,
      toolName: message.toolName ?? undefined,
    }));

    const doc = await ConversationModel.create({
      userId,
      projectId: existing.projectId,
      title,
      messages,
      pendingProposals: [],
      pausedBatch: null,
    });

    return toConversation(doc.toObject() as Parameters<typeof toConversation>[0]);
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
    return withConversationSaveLock(conversationId, async () => {
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
    });
  }

  async updateProposalStatus(
    userId: string,
    conversationId: string,
    proposalId: string,
    status: 'approved' | 'rejected',
    extraMessages: StoredMessage[]
  ): Promise<Conversation | null> {
    return withConversationSaveLock(conversationId, async () => {
      // Atomic positional update instead of load -> mutate one array
      // element in memory -> save the whole array back: two concurrent
      // calls approving/rejecting *different* proposals on the same
      // conversation used to race on the full pendingProposals array,
      // with whichever saved last silently reverting the other's change.
      const doc = await ConversationModel.findOneAndUpdate(
        { _id: conversationId, userId, 'pendingProposals.id': proposalId },
        {
          $set: { 'pendingProposals.$.status': status },
          $push: { messages: { $each: extraMessages } },
        },
        { new: true }
      ).lean();

      if (!doc) return null;
      return toConversation(doc as Parameters<typeof toConversation>[0]);
    });
  }

  async clearPauseState(
    userId: string,
    conversationId: string,
    messages: StoredMessage[]
  ): Promise<Conversation | null> {
    return withConversationSaveLock(conversationId, async () => {
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
    });
  }
}

export const conversationService = new ConversationService();
