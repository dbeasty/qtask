import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';
import { getUserId } from '../middleware/index.js';
import { agentService } from '../services/agentService.js';
import { conversationService } from '../services/conversationService.js';
import { stagingService } from '../services/stagingService.js';
import { createLogger } from '../utils/logger.js';
import { AbortError } from '../utils/abortSignal.js';

const log = createLogger('agentRoute');

export const agentRouter = Router();

const agentChatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.nodeEnv === 'production' ? 60 : 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many agent requests, please try again later' },
});

function createRequestAbortSignal(req: import('express').Request): AbortSignal {
  const controller = new AbortController();
  const onClose = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  req.on('close', onClose);
  req.on('aborted', onClose);
  return controller.signal;
}

async function streamEvents(
  res: import('express').Response,
  generator: AsyncGenerator<import('../types/conversation.js').AgentStreamEvent>,
  signal?: AbortSignal
) {
  try {
    for await (const event of generator) {
      if (signal?.aborted) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (error) {
    if (!(error instanceof AbortError)) throw error;
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
}

agentRouter.get('/conversations', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const projectId = req.query.projectId as string | undefined;
    if (projectId) {
      const { projectService } = await import('../services/projectService.js');
      await projectService.assertProjectAccess(userId, projectId, 'viewer');
    }
    const conversations = await conversationService.listConversations(userId, projectId);
    res.json({ conversations });
  } catch (error) {
    next(error);
  }
});

agentRouter.get('/conversations/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const conversation = await agentService.getConversationForUi(userId, req.params.id!);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ conversation });
  } catch (error) {
    next(error);
  }
});

agentRouter.delete('/conversations/:id', async (req, res, next) => {
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

agentRouter.post('/conversations/:id/reset', async (req, res, next) => {
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

agentRouter.post('/conversations/:id/duplicate', async (req, res, next) => {
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

agentRouter.post('/agent', agentChatLimiter, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { message, conversationId, projectId } = req.body as {
      message?: string;
      conversationId?: string;
      projectId?: string;
    };

    if (!message?.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    log.info('Agent request', { userId, conversationId: conversationId ?? 'new' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const signal = createRequestAbortSignal(req);
    await streamEvents(
      res,
      agentService.streamAgent(userId, message.trim(), conversationId, projectId, signal),
      signal
    );

    log.info('Agent stream completed', { userId, conversationId });
  } catch (error) {
    if (res.headersSent) {
      const message = error instanceof Error ? error.message : 'Agent request failed';
      log.error('Agent stream error', { message });
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
      return;
    }
    next(error);
  }
});

agentRouter.post('/agent/proposals', async (req, res, next) => {
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

    const result = await agentService.submitManualProposal(userId, conversationId, name, toolArgs);
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ proposal: result.proposal });
  } catch (error) {
    next(error);
  }
});

agentRouter.post('/agent/approve', agentChatLimiter, async (req, res, next) => {
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

    const signal = createRequestAbortSignal(req);
    await streamEvents(
      res,
      agentService.resumeAfterApproval(userId, conversationId, proposalId, action, signal),
      signal
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
