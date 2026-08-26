/**
 * A send should be blocked only when a stream is already in flight for a
 * conversation whose real id the client doesn't know yet — sending would
 * pass conversationId=undefined again and fork a second conversation
 * server-side instead of continuing the one already being created.
 * Once conversationId is known, an in-flight stream can be safely aborted
 * and replaced (the interrupt-and-redirect UX), since both target the same
 * known conversation.
 */
export function shouldBlockAgentSend(
  sending: boolean,
  approvingId: string | null,
  conversationId: string | undefined
): boolean {
  return (sending || approvingId !== null) && conversationId === undefined;
}
