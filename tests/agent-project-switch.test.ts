import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findProjectByName,
  parseActiveProjectSwitchCommand,
  projectForSwitchPrompt,
  projectNameFromProposal,
  shouldOfferSwitchAfterCreateProject,
} from '../client/src/utils/agentProjectSwitch.ts';
import type { Project, UiProposal } from '../client/src/types.ts';

function makeProject(overrides: Pick<Project, '_id' | 'name'>): Project {
  return {
    userId: 'u1',
    ownerEmail: 'owner@example.com',
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const projects: Project[] = [
  makeProject({ _id: 'p1', name: 'Boat' }),
  makeProject({ _id: 'p2', name: 'Boatyard' }),
  makeProject({ _id: 'p3', name: 'Project One' }),
];

describe('parseActiveProjectSwitchCommand', () => {
  it('matches change active project phrasing', () => {
    assert.equal(parseActiveProjectSwitchCommand('change active project to boat'), 'boat');
    assert.equal(parseActiveProjectSwitchCommand('Change Active Project To Boat'), 'Boat');
    assert.equal(parseActiveProjectSwitchCommand('change active project to boat.'), 'boat');
  });

  it('matches set and switch phrasing', () => {
    assert.equal(parseActiveProjectSwitchCommand('set active project to boat'), 'boat');
    assert.equal(parseActiveProjectSwitchCommand('switch to project boat'), 'boat');
    assert.equal(parseActiveProjectSwitchCommand('switch project to boat'), 'boat');
  });

  it('supports quoted project names', () => {
    assert.equal(parseActiveProjectSwitchCommand('change active project to "Boat Project"'), 'Boat Project');
    assert.equal(parseActiveProjectSwitchCommand("switch project to 'Boat Project'"), 'Boat Project');
  });

  it('does not match partial or unrelated input', () => {
    assert.equal(parseActiveProjectSwitchCommand('please change active project to boat'), undefined);
    assert.equal(parseActiveProjectSwitchCommand('change active project to'), undefined);
    assert.equal(parseActiveProjectSwitchCommand('list all projects'), undefined);
    assert.equal(parseActiveProjectSwitchCommand(''), undefined);
  });
});

describe('findProjectByName', () => {
  it('finds exact matches case-insensitively', () => {
    assert.equal(findProjectByName('boat', projects)?._id, 'p1');
    assert.equal(findProjectByName('BOAT', projects)?._id, 'p1');
    assert.equal(findProjectByName('Project One', projects)?._id, 'p3');
  });

  it('finds unique prefix matches', () => {
    assert.equal(findProjectByName('Boat', projects)?._id, 'p1');
  });

  it('returns undefined for ambiguous or missing names', () => {
    assert.equal(findProjectByName('Bo', [projects[0]!, projects[1]!]), undefined);
    assert.equal(findProjectByName('oat', [projects[0]!, projects[1]!]), undefined);
    assert.equal(findProjectByName('missing', projects), undefined);
    assert.equal(findProjectByName('', projects), undefined);
  });
});

function createProjectProposal(
  overrides: Partial<UiProposal> = {}
): UiProposal {
  return {
    id: 'proposal-1',
    name: 'create_project',
    arguments: { name: 'Boat' },
    source: 'native',
    status: 'approved',
    stagedEntity: { kind: 'project', id: 'p-new' },
    ...overrides,
  };
}

describe('shouldOfferSwitchAfterCreateProject', () => {
  it('returns new project id for approved create_project on a different active project', () => {
    assert.equal(
      shouldOfferSwitchAfterCreateProject(createProjectProposal(), 'p3', 'approve'),
      'p-new'
    );
  });

  it('returns undefined for rejected proposals', () => {
    assert.equal(
      shouldOfferSwitchAfterCreateProject(createProjectProposal(), 'p3', 'reject'),
      undefined
    );
  });

  it('returns undefined for create_task proposals', () => {
    assert.equal(
      shouldOfferSwitchAfterCreateProject(
        createProjectProposal({ name: 'create_task', stagedEntity: { kind: 'task', id: 't1' } }),
        'p3',
        'approve'
      ),
      undefined
    );
  });

  it('returns undefined when new project is already active', () => {
    assert.equal(
      shouldOfferSwitchAfterCreateProject(
        createProjectProposal({ stagedEntity: { kind: 'project', id: 'p3' } }),
        'p3',
        'approve'
      ),
      undefined
    );
  });

  it('returns undefined when staged entity is missing', () => {
    assert.equal(
      shouldOfferSwitchAfterCreateProject(createProjectProposal({ stagedEntity: undefined }), 'p3', 'approve'),
      undefined
    );
  });
});

describe('projectNameFromProposal', () => {
  it('reads name from proposal arguments', () => {
    assert.equal(projectNameFromProposal(createProjectProposal()), 'Boat');
  });

  it('returns undefined for missing or blank names', () => {
    assert.equal(projectNameFromProposal(createProjectProposal({ arguments: {} })), undefined);
    assert.equal(projectNameFromProposal(createProjectProposal({ arguments: { name: '  ' } })), undefined);
  });
});

describe('projectForSwitchPrompt', () => {
  it('returns the fetched project when present', () => {
    assert.equal(projectForSwitchPrompt('p1', 'Boat', projects).name, 'Boat');
    assert.equal(projectForSwitchPrompt('p1', 'Boat', projects)._id, 'p1');
  });

  it('falls back to a minimal project stub when not in the list', () => {
    const stub = projectForSwitchPrompt('p-new', 'Garden', projects);
    assert.equal(stub._id, 'p-new');
    assert.equal(stub.name, 'Garden');
  });
});
