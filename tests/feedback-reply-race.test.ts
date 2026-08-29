import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';

let mongo: MongoMemoryServer;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('two concurrent admin replies to the same feedback item', () => {
  it('only one reply wins; the loser gets a 409 instead of silently overwriting it', async () => {
    const { FeedbackModel } = await import('../src/models/index.js');
    const feedbackService = await import('../src/services/feedbackService.js');

    const feedback = await FeedbackModel.create({
      userId: 'feedback-race-user',
      message: 'Something is broken',
      category: 'bug',
    });
    const id = String(feedback._id);

    // Both calls read "no adminReply yet" as true before either write lands
    // under the pre-fix check-then-set implementation, so both proceed to
    // write — the second write silently clobbers the first admin's reply
    // instead of being rejected.
    const results = await Promise.allSettled([
      feedbackService.replyToFeedback(id, 'First admin reply'),
      feedbackService.replyToFeedback(id, 'Second admin reply'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one reply must succeed');
    assert.equal(rejected.length, 1, 'exactly one reply must be rejected');

    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(rejectedReason instanceof feedbackService.FeedbackValidationError);
    assert.equal(rejectedReason.statusCode, 409);

    const final = await FeedbackModel.findById(id).lean();
    const winningMessage = (fulfilled[0] as PromiseFulfilledResult<{ adminReply?: { message: string } }>).value
      ?.adminReply?.message;
    assert.equal(
      final?.adminReply?.message,
      winningMessage,
      'the stored reply must match whichever call actually won, not be silently overwritten'
    );
  });
});
