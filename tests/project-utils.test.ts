import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PROJECT_NAME,
  extractProjectNameFromText,
  getDefaultProject,
  groupTasksByProject,
  projectIdToName,
  resolveProjectId,
  suggestProjectFromMessages,
  taskBelongsToProject,
  taskProjectIds,
} from '../client/src/utils/project.ts';
import type { Project, Task, UiMessage } from '../client/src/types.ts';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    _id: 'p1',
    userId: 'u1',
    ownerEmail: 'owner@example.com',
    name: 'A Project',
    sortOrder: 0,
    status: 'todo',
    percentComplete: 0,
    role: 'owner',
    canEdit: true,
    canUpdateStatus: true,
    canManageMembers: true,
    canManageStructure: true,
    canDeleteProjects: true,
    canDeleteOwnTasks: true,
    collaborators: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Project;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    _id: 't1',
    userId: 'u1',
    projectIds: [],
    title: 'Task',
    status: 'todo',
    priority: 'medium',
    tags: [],
    percentComplete: 0,
    subtasks: [],
    ...overrides,
  } as Task;
}

describe('project utils', () => {
  it('extractProjectNameFromText picks up "project called X" and "for the X project" phrasing', () => {
    assert.equal(extractProjectNameFromText('Create a project called Garden Shed'), 'Garden Shed');
    assert.equal(extractProjectNameFromText('Add a task for the Kitchen Remodel project'), 'Kitchen Remodel');
    assert.equal(extractProjectNameFromText('Just a task with no project mention'), undefined);
  });

  it('suggestProjectFromMessages matches an existing project name case-insensitively', () => {
    const messages: UiMessage[] = [{ id: 'm1', role: 'user', content: 'project called garden shed' }];
    const projects = [makeProject({ name: 'Garden Shed' })];
    assert.equal(suggestProjectFromMessages(messages, projects), 'Garden Shed');
  });

  it('suggestProjectFromMessages falls back to the extracted name when no project matches', () => {
    const messages: UiMessage[] = [{ id: 'm1', role: 'user', content: 'project called Brand New Thing' }];
    assert.equal(suggestProjectFromMessages(messages, []), 'Brand New Thing');
  });

  it('suggestProjectFromMessages returns undefined when there is no user message at all', () => {
    const messages: UiMessage[] = [{ id: 'm1', role: 'assistant', content: 'project called X' }];
    assert.equal(suggestProjectFromMessages(messages, []), undefined);
  });

  it('resolveProjectId returns the existing project id without creating a new one', async () => {
    const projects = [makeProject({ _id: 'existing-id', name: 'Existing' })];
    let created = false;
    const id = await resolveProjectId('existing', projects, async (body) => {
      created = true;
      return { project: makeProject({ _id: 'new-id', name: body.name }) };
    });
    assert.equal(id, 'existing-id');
    assert.equal(created, false);
  });

  it('resolveProjectId creates a new project when no match exists', async () => {
    const id = await resolveProjectId('Brand New', [], async (body) => ({
      project: makeProject({ _id: 'new-id', name: body.name }),
    }));
    assert.equal(id, 'new-id');
  });

  it('resolveProjectId returns undefined for a blank/whitespace-only name', async () => {
    const id = await resolveProjectId('   ', [], async () => {
      throw new Error('must not be called for a blank name');
    });
    assert.equal(id, undefined);
  });

  it('projectIdToName looks up the name or returns an empty string', () => {
    const projects = [makeProject({ _id: 'p1', name: 'Alpha' })];
    assert.equal(projectIdToName('p1', projects), 'Alpha');
    assert.equal(projectIdToName('missing', projects), '');
    assert.equal(projectIdToName('', projects), '');
  });

  it('getDefaultProject prefers the project literally named "Project One"', () => {
    const projects = [makeProject({ _id: 'a', name: 'Other' }), makeProject({ _id: 'b', name: DEFAULT_PROJECT_NAME })];
    assert.equal(getDefaultProject(projects)?._id, 'b');
  });

  it('getDefaultProject falls back to the first project when none is named "Project One"', () => {
    const projects = [makeProject({ _id: 'a', name: 'Other' })];
    assert.equal(getDefaultProject(projects)?._id, 'a');
  });

  it('taskProjectIds prefers the projectIds array, falling back to the legacy projectId field', () => {
    assert.deepEqual(taskProjectIds(makeTask({ projectIds: ['a', 'b'] })), ['a', 'b']);
    assert.deepEqual(taskProjectIds(makeTask({ projectIds: [], projectId: 'legacy' })), ['legacy']);
    assert.deepEqual(taskProjectIds(makeTask({ projectIds: [] })), []);
  });

  it('taskBelongsToProject checks membership across both id sources', () => {
    assert.equal(taskBelongsToProject(makeTask({ projectIds: ['a', 'b'] }), 'b'), true);
    assert.equal(taskBelongsToProject(makeTask({ projectIds: ['a'] }), 'c'), false);
    assert.equal(taskBelongsToProject(makeTask({ projectIds: [], projectId: 'legacy' }), 'legacy'), true);
  });

  it('groupTasksByProject buckets each task under every project it belongs to', () => {
    const projects = [makeProject({ _id: 'p1', name: 'P1' }), makeProject({ _id: 'p2', name: 'P2' })];
    const tasks = [
      makeTask({ _id: 't1', projectIds: ['p1'] }),
      makeTask({ _id: 't2', projectIds: ['p1', 'p2'] }),
      makeTask({ _id: 't3', projectIds: ['p2'] }),
    ];
    const groups = groupTasksByProject(tasks, projects);
    const p1 = groups.find((g) => g.projectId === 'p1')!;
    const p2 = groups.find((g) => g.projectId === 'p2')!;
    assert.deepEqual(p1.tasks.map((t) => t._id).sort(), ['t1', 't2']);
    assert.deepEqual(p2.tasks.map((t) => t._id).sort(), ['t2', 't3']);
  });

  it('groupTasksByProject falls a project-less task through to the default project', () => {
    const projects = [makeProject({ _id: 'default-id', name: DEFAULT_PROJECT_NAME })];
    const tasks = [makeTask({ _id: 'orphan', projectIds: [] })];
    const groups = groupTasksByProject(tasks, projects);
    assert.deepEqual(groups[0]!.tasks.map((t) => t._id), ['orphan']);
  });
});
