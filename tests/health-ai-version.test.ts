import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let app: Express;
let originalFetch: typeof fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  originalFetch = globalThis.fetch;

  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await mongoose.disconnect();
  await mongo.stop();
});

describe('health aiVersion', () => {
  it('includes aiVersion from Jetson sidecar when configured', async () => {
    const { config } = await import('../src/config/index.js');
    const previousJetson = config.resourceMonitoring.jetsonGpuStatsUrl;
    (config.resourceMonitoring as { jetsonGpuStatsUrl?: string }).jetsonGpuStatsUrl =
      'http://jetson.test:9401/gpu';

    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('9401/version')) {
        return new Response(JSON.stringify({ component: 'qtask-ollama', version: '0.1.24' }), {
          status: 200,
        });
      }
      return originalFetch(input);
    }) as typeof fetch;

    try {
      const res = await request(app).get('/health').expect(200);
      assert.equal(res.body.aiVersion, '0.1.24');
    } finally {
      (config.resourceMonitoring as { jetsonGpuStatsUrl?: string }).jetsonGpuStatsUrl =
        previousJetson;
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null aiVersion when Jetson sidecar is not configured', async () => {
    const { config } = await import('../src/config/index.js');
    const previousJetson = config.resourceMonitoring.jetsonGpuStatsUrl;
    (config.resourceMonitoring as { jetsonGpuStatsUrl?: string }).jetsonGpuStatsUrl = undefined;

    try {
      const res = await request(app).get('/health').expect(200);
      assert.equal(res.body.aiVersion, null);
    } finally {
      (config.resourceMonitoring as { jetsonGpuStatsUrl?: string }).jetsonGpuStatsUrl =
        previousJetson;
    }
  });
});
