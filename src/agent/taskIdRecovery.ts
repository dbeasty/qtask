import type { StoredMessage } from '../types/conversation.js';

export const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export const UPDATE_TASK_ID_RECOVERY_GUIDANCE =
  'RECOVERY: The previous update_task used an invalid or unknown taskId. ' +
  'Copy a real "_id" from the find_tasks results above and invoke update_task again via the tool-calling API ' +
  'so the user can approve the corrected change. If multiple tasks match, ask which one. ' +
  'If none match, say so — do not invent ids and do not create a task unless the user asked to create one. ' +
  'Do not call get_task with a fabricated id.';

export function isValidObjectId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value);
}

/** True when an update_task failure should trigger an automatic find_tasks lookup. */
export function needsUpdateTaskIdRecovery(toolName: string, errorOrResult: string): boolean {
  if (toolName !== 'update_task') return false;

  if (/Task not found/i.test(errorOrResult)) return true;
  if (/must be a real 24-character/i.test(errorOrResult)) return true;
  if (/Cast to ObjectId|not a valid ObjectId|invalid ObjectId/i.test(errorOrResult)) return true;

  return /taskId/i.test(errorOrResult) && /invalid|ObjectId/i.test(errorOrResult);
}

export function latestUserContent(
  messages: Array<{ role: string; content: string }>
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user' && message.content.trim()) {
      return message.content.trim();
    }
  }
  return undefined;
}

/**
 * Build find_tasks args for recovery. Prefer the latest user request as search context;
 * fall back to the proposed new title if present.
 */
export function buildFindTasksRecoveryArgs(
  updateArgs: Record<string, unknown>,
  messages: Array<{ role: string; content: string }> | StoredMessage[]
): Record<string, unknown> {
  const latestUser = latestUserContent(messages);
  const title = typeof updateArgs.title === 'string' ? updateArgs.title.trim() : '';
  const query = latestUser || title;

  const args: Record<string, unknown> = { limit: 10 };
  if (query) args.query = query;
  return args;
}

export function wrapFindTasksRecoveryResult(findTasksResultText: string): string {
  return `${findTasksResultText}\n\n${UPDATE_TASK_ID_RECOVERY_GUIDANCE}`;
}
