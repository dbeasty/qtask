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

async function ttlIndexSeconds(
  model: { collection: { indexes: () => Promise<Array<Record<string, unknown>>> } },
  key: string
): Promise<number | undefined> {
  const indexes = await model.collection.indexes();
  const match = indexes.find(
    (idx) => (idx.key as Record<string, unknown> | undefined)?.[key] === 1 && 'expireAfterSeconds' in idx
  );
  return match?.expireAfterSeconds as number | undefined;
}

describe('RT-L2: OAuth codes, refresh tokens, and pending consents expire automatically', () => {
  it('mcpOAuthAuthorizationCode has a TTL index on expiresAt', async () => {
    const { McpOAuthAuthorizationCodeModel } = await import('../src/models/index.js');
    assert.equal(await ttlIndexSeconds(McpOAuthAuthorizationCodeModel, 'expiresAt'), 0);
  });

  it('mcpOAuthRefreshToken has a TTL index on expiresAt', async () => {
    const { McpOAuthRefreshTokenModel } = await import('../src/models/index.js');
    assert.equal(await ttlIndexSeconds(McpOAuthRefreshTokenModel, 'expiresAt'), 0);
  });

  it('mcpOAuthPendingConsent has a TTL index on expiresAt', async () => {
    const { McpOAuthPendingConsentModel } = await import('../src/models/index.js');
    assert.equal(await ttlIndexSeconds(McpOAuthPendingConsentModel, 'expiresAt'), 0);
  });

  it('userOAuthAuthCode has a TTL index on expiresAt', async () => {
    const { UserOAuthAuthCodeModel } = await import('../src/models/index.js');
    assert.equal(await ttlIndexSeconds(UserOAuthAuthCodeModel, 'expiresAt'), 0);
  });
});
