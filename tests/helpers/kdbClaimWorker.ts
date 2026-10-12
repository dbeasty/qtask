/**
 * A child process for tests/data-kdb-multiprocess.test.ts: connects to the KDB named in the
 * environment and performs conditional updates against one document, reporting how many
 * succeeded. It shares no memory (and so no lock) with the other workers - only the server.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

await import('../../src/models/index.ts');
const { KdbDataStore } = await import('../../src/data/kdb/store.ts');
const store = new KdbDataStore();
await store.connect();
const tasks = store.collection('tasks');

if (process.env.WORKER_MODE === 'create-user') {
  // Race to register one email. The in-process uniqueness check is check-then-write, so several
  // processes can all pass it; only a constraint held by the server can let exactly one in.
  let outcome: string;
  try {
    await store.collection('users').create({ email: process.env.WORKER_EMAIL, displayName: 'racer', passwordHash: 'x' });
    outcome = 'created';
  } catch (error) {
    outcome = (error as { code?: number }).code === 11000 ? 'duplicate' : `error: ${(error as Error).message}`;
  }
  await store.disconnect();
  console.log(`WORKER_RESULT ${JSON.stringify({ pid: process.pid, outcome })}`);
  process.exit(0);
}

const id = process.env.WORKER_DOC_ID!;
const rounds = Number(process.env.WORKER_ROUNDS ?? 10);
let claimed = 0;

// Every worker increments the same counter, and every worker also tries to be the one that
// claims the single "owner" slot.
for (let i = 0; i < rounds; i++) {
  await tasks.updateOne({ _id: id }, { $inc: { percentComplete: 1 } });
  const result = await tasks.updateOne(
    { _id: id, description: { $exists: false } },
    { $set: { description: `claimed-by-${process.pid}` } }
  );
  if (result.modified === 1) claimed++;
}

await store.disconnect();
console.log(`WORKER_RESULT ${JSON.stringify({ pid: process.pid, claimed })}`);
