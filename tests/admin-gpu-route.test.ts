import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-user-jwt-secret';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.ADMIN_AUTH_MODE = 'password';
process.env.ADMIN_COOKIE_SECURE = 'false';
process.env.SERVE_CLIENT = 'false';
process.env.OLLAMA_BASE_URL = 'http://ollama.test:11434';

let mongo: MongoMemoryServer;
let adminApp: Express;
let originalFetch: typeof fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  originalFetch = globalThis.fetch;
  const { createAdminApp } = await import('../src/admin/app.js');
  adminApp = await createAdminApp({ connect: true, serveClient: false });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await mongoose.disconnect();
  await mongo.stop();
});

async function adminSession() {
  const agent = request.agent(adminApp);
  const login = await agent
    .post('/api/admin/auth/login')
    .send({ password: 'test-admin-password' })
    .expect(200);
  return { agent, csrf: login.body.csrfToken as string };
}

describe('admin ollama gpu routes', () => {
  it('does not include gpu stats in /ollama/status', async () => {
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/version')) {
        return new Response(JSON.stringify({ version: '0.5.0' }), { status: 200 });
      }
      if (url.includes('/api/tags')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (url.includes('/api/ps')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (url.includes('9401/gpu') || url.includes('dcgm')) {
        throw new Error('GPU collector should not be called from /ollama/status');
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const { agent } = await adminSession();
    const response = await agent.get('/api/admin/ollama/status').expect(200);
    assert.equal(response.body.gpu, undefined);
  });

  it('returns Jetson GPU stats from /ollama/gpu when configured', async () => {
    const { config } = await import('../src/config/index.js');
    const previousJetson = config.resourceMonitoring.jetsonGpuStatsUrl;
    const previousDcgm = config.resourceMonitoring.dcgmMetricsUrl;
    (config.resourceMonitoring as { jetsonGpuStatsUrl?: string }).jetsonGpuStatsUrl =
      'http://jetson.test:9401/gpu';
    (config.resourceMonitoring as { dcgmMetricsUrl?: string }).dcgmMetricsUrl = undefined;

    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('9401/gpu')) {
        return new Response(
          JSON.stringify({
            available: true,
            source: 'jetson_sysfs',
            utilizationPercent: 45,
            memoryUsedMiB: 4832,
            memoryTotalMiB: 7620,
            temperatureC: 52,
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/ps')) {
        return new Response(
          JSON.stringify({
            models: [{ name: 'llama3.2:3b', size: 4_000_000_000, size_vram: 4_000_000_000 }],
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    try {
      const { agent } = await adminSession();
      const response = await agent.get('/api/admin/ollama/gpu').expect(200);
      assert.equal(response.body.available, true);
      assert.equal(response.body.source, 'jetson_sysfs');
      assert.equal(response.body.utilizationPercent, 45);
      assert.equal(response.body.ollama?.gpuOffloadPercent, 100);
    } finally {
      (config.resourceMonitoring as { jetsonGpuStatsUrl?: string }).jetsonGpuStatsUrl =
        previousJetson;
      (config.resourceMonitoring as { dcgmMetricsUrl?: string }).dcgmMetricsUrl = previousDcgm;
    }
  });

  it('falls back to Ollama /api/ps when no GPU collector is configured', async () => {
    const { config } = await import('../src/config/index.js');
    const previousJetson = config.resourceMonitoring.jetsonGpuStatsUrl;
    const previousDcgm = config.resourceMonitoring.dcgmMetricsUrl;
    (config.resourceMonitoring as { jetsonGpuStatsUrl?: string }).jetsonGpuStatsUrl = undefined;
    (config.resourceMonitoring as { dcgmMetricsUrl?: string }).dcgmMetricsUrl = undefined;

    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/ps')) {
        return new Response(
          JSON.stringify({
            models: [{ name: 'llama3.2:3b', size: 2_000_000_000, size_vram: 2_000_000_000 }],
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    try {
      const { agent } = await adminSession();
      const response = await agent.get('/api/admin/ollama/gpu').expect(200);
      assert.equal(response.body.available, true);
      assert.equal(response.body.source, 'ollama_ps');
      assert.equal(response.body.memoryUsedMiB, 1907);
      assert.equal(response.body.ollama?.gpuOffloadPercent, 100);
      assert.equal(response.body.utilizationPercent, undefined);
    } finally {
      (config.resourceMonitoring as { jetsonGpuStatsUrl?: string }).jetsonGpuStatsUrl =
        previousJetson;
      (config.resourceMonitoring as { dcgmMetricsUrl?: string }).dcgmMetricsUrl = previousDcgm;
    }
  });
});
