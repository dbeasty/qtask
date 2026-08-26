import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { waitForNewestToken } from './helpers/testEmail.js';

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

beforeEach(async () => {
  const { clearTestEmailOutbox } = await import('../src/services/emailService.js');
  clearTestEmailOutbox();
});

after(async () => {
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

async function registerAndVerify(email: string, password = 'password1234') {
  const { testEmailOutbox } = await import('../src/services/emailService.js');
  const previousTokenCount = testEmailOutbox.verification.length;

  await request(app)
    .post('/api/auth/register')
    .send({ email, password, acceptLegal: true })
    .expect(201);

  const token = await waitForNewestToken(() => testEmailOutbox.verification, previousTokenCount);

  await request(app).post('/api/auth/verify-email').send({ token }).expect(200);

  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { token: login.body.token as string, email };
}

async function inviteCollaborator(
  ownerToken: string,
  invitee: { token: string; email: string },
  projectId: string
) {
  const inviteRes = await request(app)
    .post(`/api/projects/${projectId}/collaborators`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email: invitee.email, role: 'editor' })
    .expect(201);

  await request(app)
    .post(`/api/invites/${inviteRes.body.invite._id}/accept`)
    .set('Authorization', `Bearer ${invitee.token}`)
    .expect(200);
}

describe('listProjects batched owner/collaborator lookup', () => {
  it('returns correct owner/collaborator data per project with a bounded number of user lookups', async () => {
    const owner = await registerAndVerify('batch-owner@example.com');
    const collabA = await registerAndVerify('batch-collab-a@example.com');
    const collabB = await registerAndVerify('batch-collab-b@example.com');
    const collabC = await registerAndVerify('batch-collab-c@example.com');

    const projects: Array<{ id: string; collaborator: { email: string } }> = [];
    for (const collab of [collabA, collabB, collabC]) {
      const created = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ name: `Project for ${collab.email}` })
        .expect(201);
      const projectId = created.body.project._id as string;
      await inviteCollaborator(owner.token, collab, projectId);
      projects.push({ id: projectId, collaborator: collab });
    }

    const { UserModel } = await import('../src/models/index.js');
    const originalFind = UserModel.find.bind(UserModel);
    let findCalls = 0;
    (UserModel as unknown as { find: typeof originalFind }).find = ((...args: Parameters<typeof originalFind>) => {
      findCalls += 1;
      return originalFind(...args);
    }) as typeof originalFind;

    let list: request.Response;
    try {
      list = await request(app)
        .get('/api/projects')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
    } finally {
      (UserModel as unknown as { find: typeof originalFind }).find = originalFind;
    }

    // One batched UserModel.find covering every project's owner +
    // collaborators, not one (or more) per project — the N+1 this fixed.
    assert.ok(
      findCalls <= 1,
      `expected at most 1 batched UserModel.find call for 3 projects, got ${findCalls}`
    );

    // And the batching must not cross-contaminate: each project's own
    // collaborator, not another project's, must come back.
    for (const { id, collaborator } of projects) {
      const project = list.body.projects.find((p: { _id: string }) => p._id === id);
      assert.ok(project, `project ${id} missing from list`);
      assert.equal(project.ownerEmail, owner.email);
      assert.equal(project.collaborators.length, 1);
      assert.equal(project.collaborators[0].email, collaborator.email);
    }
  });
});
