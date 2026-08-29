import { after, before, describe, it } from 'node:test';
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

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('two concurrent registrations for the same email', () => {
  it('the loser gets a 409, not a 500', async () => {
    const email = 'race-register@example.com';
    const body = { email, password: 'password1234', acceptLegal: true };

    // Both requests read UserModel.findOne() before either write lands, so
    // both pass the pre-check and race on UserModel.create() — the unique
    // index on email then rejects one of them with a raw MongoDB
    // duplicate-key error that the pre-fix code never translated.
    const [first, second] = await Promise.all([
      request(app).post('/api/auth/register').send(body),
      request(app).post('/api/auth/register').send(body),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409], `expected one 201 and one 409, got ${JSON.stringify(statuses)}`);

    const loser = first.status === 409 ? first : second;
    assert.match(loser.body.error, /already exists/i);
  });
});
