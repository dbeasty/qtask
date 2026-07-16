import { Router } from 'express';
import { getUserId } from '../middleware/index.js';
import { chatService } from '../services/chatService.js';
import { conversationService } from '../services/conversationService.js';
import { stagingService } from '../services/stagingService.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('chatRoute');

export const chatRouter = Router();

async function streamEvents(
  res: import('express').Response,
  generator: AsyncGenerator<import('../types/conversation.js').ChatStreamEvent>
) {
  for await (const event of generator) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

chatRouter.get('/conversations', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const conversations = await conversationService.listConversations(userId);
    res.json({ conversations });
  } catch (error) {
    next(error);
  }
});

chatRouter.get('/conversations/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const conversation = await chatService.getConversationForUi(userId, req.params.id!);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ conversation });
  } catch (error) {
    next(error);
  }
});

chatRouter.delete('/conversations/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const conversationId = req.params.id!;
    const conversation = await conversationService.getConversation(userId, conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const discardedStagedCount = await stagingService.rollbackStaleForConversation(
      userId,
      conversationId
    );
    const deleted = await conversationService.deleteConversation(userId, conversationId);
    if (!deleted) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    res.json({ discardedStagedCount });
  } catch (error) {
    next(error);
  }
});

chatRouter.post('/conversations/:id/reset', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const conversationId = req.params.id!;
    const existing = await conversationService.getConversation(userId, conversationId);
    if (!existing) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const discardedStagedCount = await stagingService.rollbackStaleForConversation(
      userId,
      conversationId
    );
    const conversation = await conversationService.resetConversation(userId, conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    res.json({ conversation, discardedStagedCount });
  } catch (error) {
    next(error);
  }
});

chatRouter.post('/conversations/:id/duplicate', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const conversationId = req.params.id!;
    const conversation = await conversationService.duplicateConversation(userId, conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    res.json({ conversation });
  } catch (error) {
    next(error);
  }
});

chatRouter.post('/chat', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { message, conversationId } = req.body as { message?: string; conversationId?: string };

    if (!message?.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    log.info('Chat request', { userId, conversationId: conversationId ?? 'new' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    await streamEvents(
      res,
      chatService.streamChat(userId, message.trim(), conversationId)
    );

    log.info('Chat stream completed', { userId, conversationId });
  } catch (error) {
    if (res.headersSent) {
      const message = error instanceof Error ? error.message : 'Chat failed';
      log.error('Chat stream error', { message });
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
      return;
    }
    next(error);
  }
});

chatRouter.post('/chat/proposals', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { conversationId, name, arguments: toolArgs } = req.body as {
      conversationId?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    };

    if (!conversationId || !name || !toolArgs) {
      res.status(400).json({ error: 'conversationId, name, and arguments are required' });
      return;
    }

    const result = await chatService.submitManualProposal(userId, conversationId, name, toolArgs);
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ proposal: result.proposal });
  } catch (error) {
    next(error);
  }
});

chatRouter.post('/chat/approve', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { conversationId, proposalId, action } = req.body as {
      conversationId?: string;
      proposalId?: string;
      action?: 'approve' | 'reject';
    };

    if (!conversationId || !proposalId || !action) {
      res.status(400).json({ error: 'conversationId, proposalId, and action are required' });
      return;
    }

    if (action !== 'approve' && action !== 'reject') {
      res.status(400).json({ error: 'action must be approve or reject' });
      return;
    }

    log.info('Approve request', { userId, conversationId, proposalId, action });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    await streamEvents(
      res,
      chatService.resumeAfterApproval(userId, conversationId, proposalId, action)
    );

    log.info('Approve stream completed', { userId, conversationId, proposalId, action });
  } catch (error) {
    if (res.headersSent) {
      const message = error instanceof Error ? error.message : 'Approval failed';
      log.error('Approve stream error', { message });
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
      return;
    }
    next(error);
  }
});
