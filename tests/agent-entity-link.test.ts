import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterToolCallsEntityLinks, getProposalEntityLink } from '../client/src/utils/agentEntityLink.ts';
import type { UiProposal } from '../client/src/types.ts';

const ACTIVE = 'proj-active-123';

function proposal(overrides: Partial<UiProposal> & Pick<UiProposal, 'name'>): UiProposal {
  return {
    id: 'prop-1',
    arguments: {},
    source: 'native',
    status: 'pending',
    ...overrides,
  };
}

describe('getProposalEntityLink', () => {
  it('returns null for pending create_task', () => {
    const link = getProposalEntityLink(
      proposal({
        name: 'create_task',
        status: 'pending',
        stagedEntity: { kind: 'task', id: 'task-1' },
        arguments: { title: 'Wash car', projectId: ACTIVE },
      }),
      ACTIVE
    );
    assert.equal(link, null);
  });

  it('returns task link for approved create_task in active project', () => {
    const link = getProposalEntityLink(
      proposal({
        name: 'create_task',
        status: 'approved',
        stagedEntity: { kind: 'task', id: 'task-1' },
        arguments: { title: 'Wash car', projectId: ACTIVE, status: 'todo', percentComplete: 0 },
      }),
      ACTIVE
    );
    assert.deepEqual(link, {
      kind: 'task',
      id: 'task-1',
      label: 'Wash car',
      status: 'todo',
      percentComplete: 0,
    });
  });

  it('hides create_task when projectId differs from active project', () => {
    const link = getProposalEntityLink(
      proposal({
        name: 'create_task',
        status: 'approved',
        stagedEntity: { kind: 'task', id: 'task-1' },
        arguments: { title: 'Other', projectId: 'other-project' },
      }),
      ACTIVE
    );
    assert.equal(link, null);
  });

  it('returns project link for approved create_project regardless of active project', () => {
    const link = getProposalEntityLink(
      proposal({
        name: 'create_project',
        status: 'approved',
        stagedEntity: { kind: 'project', id: 'proj-new' },
        arguments: { name: 'New Workspace' },
      }),
      ACTIVE
    );
    assert.deepEqual(link, {
      kind: 'project',
      id: 'proj-new',
      label: 'New Workspace',
    });
  });

  it('returns null for pending update_task', () => {
    const link = getProposalEntityLink(
      proposal({
        name: 'update_task',
        status: 'pending',
        arguments: { taskId: 'task-1', title: 'Updated', description: 'More detail' },
      }),
      ACTIVE
    );
    assert.equal(link, null);
  });

  it('returns task link for approved update_task in active project', () => {
    const link = getProposalEntityLink(
      proposal({
        name: 'update_task',
        status: 'approved',
        arguments: {
          taskId: 'task-2',
          title: 'Updated title',
          status: 'in_progress',
          percentComplete: 40,
        },
      }),
      ACTIVE
    );
    assert.deepEqual(link, {
      kind: 'task',
      id: 'task-2',
      label: 'Updated title',
      status: 'in_progress',
      percentComplete: 40,
    });
  });

  it('hides update_project when projectId is not active project', () => {
    const link = getProposalEntityLink(
      proposal({
        name: 'update_project',
        status: 'approved',
        arguments: { projectId: 'other-project', name: 'Renamed' },
      }),
      ACTIVE
    );
    assert.equal(link, null);
  });

  it('returns project link for approved update_project on active project', () => {
    const link = getProposalEntityLink(
      proposal({
        name: 'update_project',
        status: 'approved',
        arguments: { projectId: ACTIVE, name: 'Renamed project' },
      }),
      ACTIVE
    );
    assert.deepEqual(link, {
      kind: 'project',
      id: ACTIVE,
      label: 'Renamed project',
    });
  });

  it('returns null for rejected proposals', () => {
    const link = getProposalEntityLink(
      proposal({
        name: 'create_task',
        status: 'rejected',
        stagedEntity: { kind: 'task', id: 'task-1' },
        arguments: { title: 'Nope', projectId: ACTIVE },
      }),
      ACTIVE
    );
    assert.equal(link, null);
  });

  it('returns null for unrelated tools', () => {
    const link = getProposalEntityLink(
      proposal({
        name: 'assign_task',
        status: 'approved',
        arguments: { taskId: 'task-1' },
      }),
      ACTIVE
    );
    assert.equal(link, null);
  });
});

describe('filterToolCallsEntityLinks', () => {
  it('filters find_tasks after get_project in same message', () => {
    const filtered = filterToolCallsEntityLinks([
      {
        name: 'get_project',
        success: true,
        entityLinks: [{ kind: 'project', id: 'boat', label: 'Boat' }],
      },
      {
        name: 'find_tasks',
        success: true,
        entityLinks: [
          { kind: 'task', id: 't1', label: 'Wash boat', projectId: 'boat' },
          { kind: 'task', id: 't2', label: 'Wash car', projectId: 'car' },
        ],
      },
    ]);

    assert.equal(filtered[1]?.entityLinks?.length, 1);
    assert.equal(filtered[1]?.entityLinks?.[0]?.id, 't1');
  });

  it('leaves find_tasks unfiltered without prior project highlight', () => {
    const filtered = filterToolCallsEntityLinks([
      {
        name: 'find_tasks',
        success: true,
        entityLinks: [
          { kind: 'task', id: 't1', label: 'A', projectId: 'p1' },
          { kind: 'task', id: 't2', label: 'B', projectId: 'p2' },
        ],
      },
    ]);

    assert.equal(filtered[0]?.entityLinks?.length, 2);
  });
});
