import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-user-secret';
process.env.LLM_METRICS_RETENTION_DAYS = '30';

let mongo: MongoMemoryServer;
const originalFetch = globalThis.fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await mongoose.disconnect();
  await mongo.stop();
});

describe('LLM call metrics', () => {
  it('captures final streamed Ollama timing and token fields without content', async () => {
    globalThis.fetch = async () =>
      new Response(
        [
          JSON.stringify({ message: { role: 'assistant', content: 'Hello' }, done: false }),
          JSON.stringify({
            message: { role: 'assistant', content: '' },
            done: true,
            total_duration: 2_000_000,
            load_duration: 100_000,
            prompt_eval_count: 12,
            prompt_eval_duration: 300_000,
            eval_count: 4,
            eval_duration: 700_000,
          }),
          '',
        ].join('\n'),
        { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
      );

    const { streamOllamaChat } = await import('../src/services/chatService.js');
    for await (const _part of streamOllamaChat(
      [{ role: 'user', content: 'Secret prompt that must not be stored' }],
      0,
      '507f1f77bcf86cd799439011',
      'conversation-1'
    )) {
      // Consume the full stream so the final metric is persisted.
    }

    const { LlmCallMetricModel, LlmDailyMetricModel } = await import('../src/models/index.js');
    let metric = await LlmCallMetricModel.findOne();
    for (let attempt = 0; !metric && attempt < 80; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      metric = await LlmCallMetricModel.findOne();
    }

    assert.ok(metric);
    assert.equal(metric.callType, 'chat');
    assert.equal(metric.promptEvalCount, 12);
    assert.equal(metric.evalCount, 4);
    assert.equal(metric.totalDurationNs, 2_000_000);
    assert.equal(metric.success, true);
    assert.ok(metric.expiresAt.getTime() > Date.now() + 29 * 24 * 60 * 60 * 1000);
    assert.equal(
      JSON.stringify(metric.toObject()).includes('Secret prompt that must not be stored'),
      false
    );

    let daily = await LlmDailyMetricModel.findOne();
    for (let attempt = 0; !daily && attempt < 80; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      daily = await LlmDailyMetricModel.findOne();
    }
    assert.ok(daily);
    assert.equal(daily.calls, 1);
    assert.equal(daily.promptTokens, 12);
    assert.equal(daily.evalTokens, 4);
  });
});
