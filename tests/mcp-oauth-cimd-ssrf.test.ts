import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

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

describe('CIMD client_id SSRF guard', () => {
  it('rejects loopback, RFC1918, link-local, and cloud-metadata hosts', async () => {
    const { mcpOAuthClientService } = await import('../src/services/mcpOAuthClientService.js');

    const disallowed = [
      'https://127.0.0.1/client.json',
      'https://10.0.0.5/client.json',
      'https://192.168.1.1/client.json',
      'https://172.16.5.5/client.json',
      'https://169.254.169.254/client.json', // cloud metadata endpoint
      'https://localhost/client.json',
      'https://[::1]/client.json',
    ];

    for (const url of disallowed) {
      await assert.rejects(
        () => mcpOAuthClientService.resolveClient(url),
        /not allowed/,
        `expected ${url} to be rejected`
      );
    }
  });

  it('leaves non-URL client ids to the normal lookup path (no SSRF check triggered)', async () => {
    const { mcpOAuthClientService } = await import('../src/services/mcpOAuthClientService.js');
    const result = await mcpOAuthClientService.resolveClient('qto_some_registered_id');
    assert.equal(result, null);
  });
});
