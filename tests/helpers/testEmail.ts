/**
 * Registration awaits sendVerificationEmail server-side, so by the time the
 * POST /api/auth/register response resolves the token has already been
 * pushed to testEmailOutbox — but under full-suite load an unrelated async
 * leak from a prior test can land a stray push right after this test's
 * beforeEach clears the outbox, making a bare `.at(-1)` read grab the wrong
 * token. Capture the outbox length before the request and poll briefly for
 * it to grow past that, so the token returned is always the one this call
 * actually produced.
 */
export async function waitForNewestToken(
  getTokens: () => string[],
  previousLength: number,
  timeoutMs = 2000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tokens = getTokens();
    if (tokens.length > previousLength) {
      return tokens[tokens.length - 1]!;
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for a new token to appear in the test email outbox');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
