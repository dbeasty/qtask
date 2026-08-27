import { after, before, beforeEach, describe, it } from 'node:test';
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

beforeEach(async () => {
  const { McpOAuthClientModel } = await import('../src/models/index.js');
  await McpOAuthClientModel.deleteMany({});
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('self-service registered OAuth clients (empty redirectUris) only accept loopback redirects', () => {
  it('accepts loopback redirect_uri variants', async () => {
    const { mcpOAuthClientService } = await import('../src/services/mcpOAuthClientService.js');
    const { clientId } = await mcpOAuthClientService.createRegisteredClient('user-1', 'CLI Tool');
    const client = await mcpOAuthClientService.resolveClient(clientId);
    assert.ok(client);

    assert.equal(mcpOAuthClientService.validateRedirectUri(client!, 'http://127.0.0.1:54321/callback'), true);
    assert.equal(mcpOAuthClientService.validateRedirectUri(client!, 'http://localhost:9999/cb'), true);
  });

  it('rejects an arbitrary https redirect_uri', async () => {
    const { mcpOAuthClientService } = await import('../src/services/mcpOAuthClientService.js');
    const { clientId } = await mcpOAuthClientService.createRegisteredClient('user-1', 'CLI Tool');
    const client = await mcpOAuthClientService.resolveClient(clientId);
    assert.ok(client);

    // A registered client's empty redirectUris used to fall back to
    // "any https:// URL", letting anyone who gets the client owner to
    // click a crafted /oauth/authorize link redirect that owner's own
    // authorization code to an attacker-controlled host.
    assert.equal(mcpOAuthClientService.validateRedirectUri(client!, 'https://attacker.example/steal'), false);
  });

  it('rejects a lookalike host that merely starts with the loopback string', async () => {
    const { mcpOAuthClientService } = await import('../src/services/mcpOAuthClientService.js');
    const { clientId } = await mcpOAuthClientService.createRegisteredClient('user-1', 'CLI Tool');
    const client = await mcpOAuthClientService.resolveClient(clientId);
    assert.ok(client);

    // "http://127.0.0.1.evil.com" satisfies a naive
    // startsWith('http://127.0.0.1') check without being loopback at all.
    assert.equal(
      mcpOAuthClientService.validateRedirectUri(client!, 'http://127.0.0.1.evil.com/phish'),
      false
    );
    assert.equal(
      mcpOAuthClientService.validateRedirectUri(client!, 'http://localhost.evil.com/phish'),
      false
    );
  });

  it('still exact-matches a DCR client\'s explicit redirect_uris (unaffected by this change)', async () => {
    const { mcpOAuthClientService } = await import('../src/services/mcpOAuthClientService.js');
    const registered = await mcpOAuthClientService.registerDynamicClient({
      client_name: 'DCR Client',
      redirect_uris: ['https://app.example/callback'],
    });
    const client = await mcpOAuthClientService.resolveClient(registered.client_id);
    assert.ok(client);

    assert.equal(
      mcpOAuthClientService.validateRedirectUri(client!, 'https://app.example/callback'),
      true
    );
    assert.equal(
      mcpOAuthClientService.validateRedirectUri(client!, 'https://attacker.example/steal'),
      false
    );
  });
});
