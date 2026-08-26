import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * requireSecret() only exempted NODE_ENV==='production' from needing a real
 * secret; every other value (unset, 'development', 'staging', ...) silently
 * signed sessions with a public fallback constant. The fix flips this to
 * fail closed for everything except NODE_ENV==='test'. This deliberately
 * does NOT set JWT_SECRET and skips dotenv, so config/index.ts's top-level
 * requireSecret('JWT_SECRET', ...) call must throw during import.
 */
process.env.QTASK_SKIP_DOTENV = 'true';
process.env.NODE_ENV = 'staging';
delete process.env.JWT_SECRET;

describe('config secret requirement outside test/production', () => {
  it('fails to import config when NODE_ENV=staging and JWT_SECRET is unset', async () => {
    await assert.rejects(
      () => import('../src/config/index.js'),
      /JWT_SECRET is required when NODE_ENV=staging/
    );
  });
});
