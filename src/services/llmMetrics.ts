import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { LlmCallMetricModel, LlmDailyMetricModel } from '../models/index.js';

export type LlmCallType = 'chat' | 'generate' | 'embed';
export type LlmCallSource =
  | 'chat_loop'
  | 'project_summary'
  | 'embedding_job'
  | 'semantic_search';

export interface OllamaTimingFields {
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface LlmCallContext {
  callType: LlmCallType;
  source: LlmCallSource;
  model: string;
  userId?: string;
  conversationId?: string;
  taskId?: string;
  iteration?: number;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 500);
}

function errorCategory(error: unknown): string {
  if (error instanceof TypeError) return 'network';
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|abort/i.test(message)) return 'timeout';
  if (/json|parse/i.test(message)) return 'parse';
  return 'ollama';
}

export function createLlmCallTracker(context: LlmCallContext) {
  const requestId = randomUUID();
  const startedAt = new Date();
  const started = performance.now();
  let finished = false;

  async function persist(input: {
    success: boolean;
    httpStatus?: number;
    timing?: OllamaTimingFields;
    error?: unknown;
    degradedFallback?: boolean;
  }): Promise<void> {
    if (finished) return;
    finished = true;

    const completedAt = new Date();
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    const expiresAt = new Date(
      completedAt.getTime() + config.llmMetrics.retentionDays * 24 * 60 * 60 * 1000
    );
    const timing = input.timing ?? {};
    const day = new Date(Date.UTC(
      completedAt.getUTCFullYear(),
      completedAt.getUTCMonth(),
      completedAt.getUTCDate()
    ));

    try {
      await Promise.all([
        LlmCallMetricModel.create({
          requestId,
          ...context,
          startedAt,
          completedAt,
          durationMs,
          success: input.success,
          degradedFallback: input.degradedFallback === true,
          httpStatus: input.httpStatus,
          errorCategory: input.error ? errorCategory(input.error) : undefined,
          errorMessage: input.error ? safeErrorMessage(input.error) : undefined,
          totalDurationNs: timing.total_duration,
          loadDurationNs: timing.load_duration,
          promptEvalCount: timing.prompt_eval_count,
          promptEvalDurationNs: timing.prompt_eval_duration,
          evalCount: timing.eval_count,
          evalDurationNs: timing.eval_duration,
          expiresAt,
        }),
        LlmDailyMetricModel.updateOne(
          {
            day,
            userId: context.userId ?? null,
            callType: context.callType,
            model: context.model,
          },
          {
            $inc: {
              calls: 1,
              successes: input.success ? 1 : 0,
              failures: input.success ? 0 : 1,
              degradedFallbacks: input.degradedFallback ? 1 : 0,
              durationMs,
              promptTokens: timing.prompt_eval_count ?? 0,
              evalTokens: timing.eval_count ?? 0,
            },
          },
          { upsert: true }
        ),
      ]);
    } catch {
      // Telemetry is best-effort and must never affect user requests.
    }
  }

  return {
    requestId,
    complete(httpStatus: number, timing?: OllamaTimingFields) {
      void persist({ success: true, httpStatus, timing });
    },
    fail(error: unknown, httpStatus?: number, degradedFallback = false) {
      void persist({ success: false, httpStatus, error, degradedFallback });
    },
  };
}
