import { before, after, beforeEach, describe, it } from 'node:test';
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

  const me = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${login.body.token}`)
    .expect(200);

  return { token: login.body.token as string, userId: me.body.user.id as string, email };
}

async function inviteCollaborator(
  ownerToken: string,
  invitee: { token: string; email: string },
  projectId: string,
  role: 'editor' | 'executor' | 'viewer' | 'manager' = 'editor'
) {
  const inviteRes = await request(app)
    .post(`/api/projects/${projectId}/collaborators`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email: invitee.email, role })
    .expect(201);

  const inviteId = inviteRes.body.invite._id as string;
  await request(app)
    .post(`/api/invites/${inviteId}/accept`)
    .set('Authorization', `Bearer ${invitee.token}`)
    .expect(200);

  return inviteRes.body.invite;
}

async function createProject(token: string, name: string, parentId?: string) {
  const res = await request(app)
    .post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, ...(parentId ? { parentId } : {}) })
    .expect(201);
  return res.body.project._id as string;
}

async function createTask(token: string, title: string, projectId: string) {
  const res = await request(app)
    .post('/api/tasks')
    .set('Authorization', `Bearer ${token}`)
    .send({ title, projectId })
    .expect(201);
  return res.body.task._id as string;
}

async function listProjects(token: string) {
  const res = await request(app)
    .get('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return res.body.projects as Array<{ _id: string; name: string }>;
}

async function listTasks(token: string) {
  const res = await request(app)
    .get('/api/tasks')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return res.body.tasks as Array<{ _id: string; title: string }>;
}

describe('project collaboration', () => {
  it('keeps non-members isolated from projects and tasks', async () => {
    const alice = await registerAndVerify('collab-alice@example.com');
    const bob = await registerAndVerify('collab-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Alice Shared' })
      .expect(201);

    const projectId = projectRes.body.project._id as string;

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Secret task', projectId })
      .expect(201);

    await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(404);

    const bobProjects = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    assert.equal(
      bobProjects.body.projects.some((p: { _id: string }) => p._id === projectId),
      false
    );

    const bobTasks = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    assert.equal(
      bobTasks.body.tasks.some((t: { title: string }) => t.title === 'Secret task'),
      false
    );
  });

  it('lets an editor collaborator list, read, and mutate shared tasks', async () => {
    const alice = await registerAndVerify('editor-alice@example.com');
    const bob = await registerAndVerify('editor-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Team Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Shared task', projectId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    const added = await inviteCollaborator(alice.token, bob, projectId, 'editor');

    assert.equal(added.inviteeEmail, bob.email);
    assert.equal(added.role, 'editor');

    const aliceProject = await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    assert.equal(aliceProject.body.project.collaborators.length, 1);
    assert.equal(aliceProject.body.project.collaborators[0].email, bob.email);

    const bobProjects = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    const shared = bobProjects.body.projects.find((p: { _id: string }) => p._id === projectId);
    assert.ok(shared);
    assert.equal(shared.role, 'editor');
    assert.equal(shared.canEdit, true);
    assert.equal(shared.canUpdateStatus, true);
    assert.equal(shared.canManageMembers, false);

    const bobTask = await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(bobTask.body.task.title, 'Shared task');

    const updated = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Updated by Bob' })
      .expect(200);
    assert.equal(updated.body.task.title, 'Updated by Bob');

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Bob created', projectId })
      .expect(201);
    assert.equal(created.body.task.projectId, projectId);

    const aliceTasks = await request(app)
      .get('/api/tasks')
      .query({ projectId })
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    assert.ok(aliceTasks.body.tasks.some((t: { title: string }) => t.title === 'Bob created'));
  });

  it('blocks viewers from mutating and blocks collaborators from managing members', async () => {
    const alice = await registerAndVerify('viewer-alice@example.com');
    const bob = await registerAndVerify('viewer-bob@example.com');
    const carol = await registerAndVerify('viewer-carol@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Read Only' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'View me', projectId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await inviteCollaborator(alice.token, bob, projectId, 'viewer');

    await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Nope' })
      .expect(403);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Nope create', projectId })
      .expect(403);

    await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ email: carol.email, role: 'editor' })
      .expect(403);

    await request(app)
      .delete(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(403);
  });

  it('allows role updates, self-leave, and removes access afterward', async () => {
    const alice = await registerAndVerify('leave-alice@example.com');
    const bob = await registerAndVerify('leave-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Leave Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    await inviteCollaborator(alice.token, bob, projectId, 'executor');

    const roleUpdated = await request(app)
      .patch(`/api/projects/${projectId}/collaborators/${bob.userId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ role: 'editor' })
      .expect(200);
    assert.equal(roleUpdated.body.project.collaborators[0].role, 'editor');

    const left = await request(app)
      .delete(`/api/projects/${projectId}/collaborators/${bob.userId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(left.body.left, true);

    await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(404);
  });

  it('lets an executor update status but not other task fields', async () => {
    const alice = await registerAndVerify('executor-alice@example.com');
    const bob = await registerAndVerify('executor-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Executor Project' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Do the work', projectId, status: 'todo' })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await inviteCollaborator(alice.token, bob, projectId, 'executor');

    const bobProjects = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    const shared = bobProjects.body.projects.find((p: { _id: string }) => p._id === projectId);
    assert.ok(shared);
    assert.equal(shared.role, 'executor');
    assert.equal(shared.canEdit, false);
    assert.equal(shared.canUpdateStatus, true);

    const statusUpdated = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ status: 'in_progress' })
      .expect(200);
    assert.equal(statusUpdated.body.task.status, 'in_progress');

    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Nope' })
      .expect(403);

    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ status: 'done', title: 'Nope' })
      .expect(403);

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Nope create', projectId })
      .expect(403);

    await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(403);
  });

  it('blocks viewers from updating status', async () => {
    const alice = await registerAndVerify('viewer-status-alice@example.com');
    const bob = await registerAndVerify('viewer-status-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Viewer Status' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Stay todo', projectId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await inviteCollaborator(alice.token, bob, projectId, 'viewer');

    const bobProjects = await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(bobProjects.body.project.canUpdateStatus, false);

    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ status: 'done' })
      .expect(403);
  });

  it('allows inviting unknown email and cannot remove the owner', async () => {
    const alice = await registerAndVerify('owner-alice@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Owner Guards' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const inviteRes = await request(app)
      .post(`/api/projects/${projectId}/collaborators`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: 'missing@example.com', role: 'editor' })
      .expect(201);

    assert.equal(inviteRes.body.invite.inviteeEmail, 'missing@example.com');
    assert.equal(inviteRes.body.invite.inviteeUserId, undefined);

    await request(app)
      .delete(`/api/projects/${projectId}/collaborators/${alice.userId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(400);
  });

  it('cascades collaborator access to descendant sub-projects and their tasks', async () => {
    const alice = await registerAndVerify('nested-alice@example.com');
    const bob = await registerAndVerify('nested-bob@example.com');

    const parentRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Parent Shared' })
      .expect(201);
    const parentId = parentRes.body.project._id as string;

    const childRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Child Work', parentId })
      .expect(201);
    const childId = childRes.body.project._id as string;

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Task in child', projectId: childId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await inviteCollaborator(alice.token, bob, parentId, 'editor');

    const bobProjects = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    assert.ok(bobProjects.body.projects.some((p: { _id: string }) => p._id === parentId));
    assert.ok(bobProjects.body.projects.some((p: { _id: string }) => p._id === childId));

    const bobTask = await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(bobTask.body.task.title, 'Task in child');

    const childTasks = await request(app)
      .get('/api/tasks')
      .query({ projectId: childId })
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(childTasks.body.tasks.length, 1);
  });

  it('lets a manager create sub-projects and edit structure but not delete or manage members', async () => {
    const alice = await registerAndVerify('manager-alice@example.com');
    const bob = await registerAndVerify('manager-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Manager Parent' })
      .expect(201);
    const parentId = projectRes.body.project._id as string;

    await inviteCollaborator(alice.token, bob, parentId, 'manager');

    const childRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ name: 'Manager Child', parentId })
      .expect(201);
    const childId = childRes.body.project._id as string;
    assert.equal(childRes.body.project.userId, alice.userId);

    const renamed = await request(app)
      .patch(`/api/projects/${parentId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ name: 'Renamed by Manager' })
      .expect(200);
    assert.equal(renamed.body.project.name, 'Renamed by Manager');

    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Manager task', projectId: childId })
      .expect(201);
    const taskId = taskRes.body.task._id as string;

    await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(403);

    await request(app)
      .delete(`/api/projects/${childId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(403);

    await request(app)
      .post(`/api/projects/${parentId}/collaborators`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ email: 'extra@example.com', role: 'viewer' })
      .expect(403);

    const bobProject = await request(app)
      .get(`/api/projects/${parentId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    assert.equal(bobProject.body.project.role, 'manager');
    assert.equal(bobProject.body.project.canManageStructure, true);
    assert.equal(bobProject.body.project.canManageMembers, false);
    assert.equal(bobProject.body.project.canDeleteProjects, false);
  });

  it('lets editors delete only tasks they created', async () => {
    const alice = await registerAndVerify('delete-alice@example.com');
    const bob = await registerAndVerify('delete-bob@example.com');

    const projectRes = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Delete Rules' })
      .expect(201);
    const projectId = projectRes.body.project._id as string;

    const aliceTaskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Alice task', projectId })
      .expect(201);
    const aliceTaskId = aliceTaskRes.body.task._id as string;

    await inviteCollaborator(alice.token, bob, projectId, 'editor');

    const bobTaskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Bob task', projectId })
      .expect(201);
    const bobTaskId = bobTaskRes.body.task._id as string;

    await request(app)
      .delete(`/api/tasks/${bobTaskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(204);

    await request(app)
      .delete(`/api/tasks/${aliceTaskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(403);
  });

  it('lists share contacts from accepted invites and owned project collaborators', async () => {
    const alice = await registerAndVerify('contacts-alice@example.com');
    const bob = await registerAndVerify('contacts-bob@example.com');
    const carol = await registerAndVerify('contacts-carol@example.com');

    const projectA = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Contacts A' })
      .expect(201);
    const projectAId = projectA.body.project._id as string;

    const projectB = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Contacts B' })
      .expect(201);
    const projectBId = projectB.body.project._id as string;

    await inviteCollaborator(alice.token, bob, projectAId, 'editor');
    await inviteCollaborator(alice.token, carol, projectBId, 'viewer');

    const contactsRes = await request(app)
      .get('/api/projects/share-contacts')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    const emails = contactsRes.body.contacts.map((c: { email: string }) => c.email);
    assert.ok(emails.includes(bob.email));
    assert.ok(emails.includes(carol.email));

    const filtered = await request(app)
      .get(`/api/projects/share-contacts?excludeProjectId=${projectAId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const filteredEmails = filtered.body.contacts.map((c: { email: string }) => c.email);
    assert.equal(filteredEmails.includes(bob.email), false);
    assert.ok(filteredEmails.includes(carol.email));
  });

  it('grants collaborators access to a project moved under a shared parent', async () => {
    const alice = await registerAndVerify('move-in-alice@example.com');
    const bob = await registerAndVerify('move-in-bob@example.com');

    const sharedId = await createProject(alice.token, 'Move-in Shared Root');
    await inviteCollaborator(alice.token, bob, sharedId, 'editor');

    // Alice already had a separate project holding real work, and drags it
    // under the shared root to share it. The share summary counts it, so the
    // collaborator has to see it too.
    const existingId = await createProject(alice.token, 'Move-in Pre-existing');
    const taskId = await createTask(alice.token, 'Work item', existingId);

    await request(app)
      .post(`/api/projects/${existingId}/move`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ parentId: sharedId })
      .expect(200);

    const summary = await request(app)
      .get(`/api/projects/${sharedId}/share-summary`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    assert.equal(summary.body.summary.totalTaskCount, 1);

    const bobProjects = await listProjects(bob.token);
    assert.ok(
      bobProjects.some((p) => p._id === existingId),
      'moved project should be visible to the collaborator'
    );

    const bobTasks = await listTasks(bob.token);
    assert.ok(
      bobTasks.some((t) => t._id === taskId),
      'tasks in the moved project should be visible to the collaborator'
    );

    await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
  });

  it('revokes collaborator access when a project moves out of a shared parent', async () => {
    const alice = await registerAndVerify('move-out-alice@example.com');
    const bob = await registerAndVerify('move-out-bob@example.com');

    const sharedId = await createProject(alice.token, 'Move-out Shared Root');
    const childId = await createProject(alice.token, 'Move-out Child', sharedId);
    const taskId = await createTask(alice.token, 'Private again', childId);
    await inviteCollaborator(alice.token, bob, sharedId, 'editor');

    await request(app)
      .post(`/api/projects/${childId}/move`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ parentId: null })
      .expect(200);

    const bobProjects = await listProjects(bob.token);
    assert.equal(
      bobProjects.some((p) => p._id === childId),
      false,
      'project moved out of the shared subtree should no longer be visible'
    );

    const bobTasks = await listTasks(bob.token);
    assert.equal(bobTasks.some((t) => t._id === taskId), false);

    await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(404);

    // The shared root itself is untouched.
    assert.ok(bobProjects.some((p) => p._id === sharedId));
  });

  it('keeps a collaborator added directly to the moved project', async () => {
    const alice = await registerAndVerify('move-direct-alice@example.com');
    const bob = await registerAndVerify('move-direct-bob@example.com');

    const parentId = await createProject(alice.token, 'Move-direct Parent');
    const childId = await createProject(alice.token, 'Move-direct Child', parentId);
    // Bob is invited to the child alone, never to the parent.
    await inviteCollaborator(alice.token, bob, childId, 'editor');

    await request(app)
      .post(`/api/projects/${childId}/move`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ parentId: null })
      .expect(200);

    const bobProjects = await listProjects(bob.token);
    assert.ok(
      bobProjects.some((p) => p._id === childId),
      'a direct share should survive a move that does not involve a shared parent'
    );
  });

  it('lets a manager reparent inside the shared tree but not out of it', async () => {
    const alice = await registerAndVerify('mgr-move-alice@example.com');
    const bob = await registerAndVerify('mgr-move-bob@example.com');

    const rootId = await createProject(alice.token, 'Mgr-move Root');
    const branchId = await createProject(alice.token, 'Mgr-move Branch', rootId);
    const leafId = await createProject(alice.token, 'Mgr-move Leaf', rootId);
    await inviteCollaborator(alice.token, bob, rootId, 'manager');

    // Inside the shared tree: allowed, and bob keeps access.
    await request(app)
      .post(`/api/projects/${leafId}/move`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ parentId: branchId })
      .expect(200);

    const afterInner = await listProjects(bob.token);
    assert.ok(afterInner.some((p) => p._id === leafId));

    // Out of the shared tree: that is an un-share, so it is owner-only. The
    // move must be refused outright rather than applied and then reported as
    // a failure because the mover just lost sight of it.
    await request(app)
      .post(`/api/projects/${leafId}/move`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ parentId: null })
      .expect(403);

    const afterOuter = await listProjects(bob.token);
    assert.ok(
      afterOuter.some((p) => p._id === leafId),
      'a refused move must not have changed anything'
    );

    const aliceProjects = await listProjects(alice.token);
    const leaf = aliceProjects.find((p) => p._id === leafId) as unknown as {
      parentId: string | null;
    };
    assert.equal(leaf.parentId, branchId, 'the refused move must not have reparented the project');

    // The owner can do it, and that un-shares the project.
    await request(app)
      .post(`/api/projects/${leafId}/move`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ parentId: null })
      .expect(200);

    const finalBob = await listProjects(bob.token);
    assert.equal(finalBob.some((p) => p._id === leafId), false);
  });

  it('revokes collaborator access to children promoted by deleting a shared project', async () => {
    const alice = await registerAndVerify('del-revoke-alice@example.com');
    const bob = await registerAndVerify('del-revoke-bob@example.com');

    const sharedId = await createProject(alice.token, 'Del-revoke Shared');
    const childId = await createProject(alice.token, 'Del-revoke Child', sharedId);
    const taskId = await createTask(alice.token, 'Orphaned work', childId);
    await inviteCollaborator(alice.token, bob, sharedId, 'editor');

    // Deleting the shared project promotes the child to the top level, out
    // of the subtree bob was invited to.
    await request(app)
      .delete(`/api/projects/${sharedId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    const bobProjects = await listProjects(bob.token);
    assert.equal(
      bobProjects.some((p) => p._id === childId),
      false,
      'a child promoted out of a deleted shared project should not stay shared'
    );

    const bobTasks = await listTasks(bob.token);
    assert.equal(bobTasks.some((t) => t._id === taskId), false);

    await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(404);

    // Alice still owns the promoted child and its task.
    const aliceProjects = await listProjects(alice.token);
    assert.ok(aliceProjects.some((p) => p._id === childId));
    await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
  });

  it('keeps collaborator access when the promoted child stays inside a shared tree', async () => {
    const alice = await registerAndVerify('del-keep-alice@example.com');
    const bob = await registerAndVerify('del-keep-bob@example.com');

    const rootId = await createProject(alice.token, 'Del-keep Root');
    const middleId = await createProject(alice.token, 'Del-keep Middle', rootId);
    const childId = await createProject(alice.token, 'Del-keep Child', middleId);
    const taskId = await createTask(alice.token, 'Still shared', childId);
    await inviteCollaborator(alice.token, bob, rootId, 'editor');

    // Deleting the middle project promotes the child to the shared root, so
    // bob keeps access.
    await request(app)
      .delete(`/api/projects/${middleId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    const bobProjects = await listProjects(bob.token);
    assert.ok(
      bobProjects.some((p) => p._id === childId),
      'a child promoted within the shared tree should stay shared'
    );

    await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    // And still as an editor, not some downgraded role.
    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'edited after promotion' })
      .expect(200);
  });

  it('cascades a collaborator role change to descendant sub-projects', async () => {
    const alice = await registerAndVerify('demote-alice@example.com');
    const bob = await registerAndVerify('demote-bob@example.com');

    const rootId = await createProject(alice.token, 'Demote Root');
    const childId = await createProject(alice.token, 'Demote Child', rootId);
    const childTaskId = await createTask(alice.token, 'Child task', childId);
    await inviteCollaborator(alice.token, bob, rootId, 'editor');

    await request(app)
      .patch(`/api/projects/${rootId}/collaborators/${bob.userId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ role: 'viewer' })
      .expect(200);

    // Demoted on the root, so bob must not still be an editor on the child.
    await request(app)
      .patch(`/api/tasks/${childTaskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'edited by demoted collaborator' })
      .expect(403);

    // Still a viewer, though.
    await request(app)
      .get(`/api/tasks/${childTaskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    // And a promotion cascades the same way.
    await request(app)
      .patch(`/api/projects/${rootId}/collaborators/${bob.userId}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ role: 'editor' })
      .expect(200);

    await request(app)
      .patch(`/api/tasks/${childTaskId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'edited after promotion' })
      .expect(200);
  });
});
