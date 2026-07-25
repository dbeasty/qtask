import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDedupedEntityLinks, aggregatedEntityLinkHeading, aggregatedEntityLinkHeadingForMessage, entityLinkSectionsFromToolCalls, filterToolCallsEntityLinks, getApprovedProposalEntityLinks, getProposalEntityLink, getProposalEntityLinks, isCreateTaskPreflightMessage, visibleProposals } from '../client/src/utils/agentEntityLink.ts';
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
      projectId: ACTIVE,
    });
  });

  it('returns task and project links for approved create_task via getProposalEntityLinks', () => {
    const links = getProposalEntityLinks(
      proposal({
        name: 'create_task',
        status: 'approved',
        stagedEntity: { kind: 'task', id: 'task-1' },
        arguments: { title: 'Put advertisement on Barnstormers', projectId: ACTIVE },
      }),
      ACTIVE,
      (id) => (id === ACTIVE ? 'Sell Airplane' : undefined)
    );
    assert.equal(links.length, 2);
    assert.deepEqual(links[0], {
      kind: 'task',
      id: 'task-1',
      label: 'Put advertisement on Barnstormers',
      status: 'todo',
      percentComplete: 0,
      projectId: ACTIVE,
    });
    assert.deepEqual(links[1], {
      kind: 'project',
      id: ACTIVE,
      label: 'Sell Airplane',
    });
  });

  it('returns project-only links for approved create_project via getProposalEntityLinks', () => {
    const links = getProposalEntityLinks(
      proposal({
        name: 'create_project',
        status: 'approved',
        stagedEntity: { kind: 'project', id: 'proj-new' },
        arguments: { name: 'New Workspace' },
      }),
      ACTIVE
    );
    assert.deepEqual(links, [
      {
        kind: 'project',
        id: 'proj-new',
        label: 'New Workspace',
      },
    ]);
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

describe('visibleProposals', () => {
  it('excludes approved proposals', () => {
    const proposals = [
      proposal({ name: 'create_task', status: 'pending' }),
      proposal({ name: 'create_project', status: 'approved' }),
      proposal({ name: 'update_task', status: 'rejected' }),
    ];
    const visible = visibleProposals(proposals);
    assert.equal(visible.length, 2);
    assert.equal(visible.some((item) => item.status === 'approved'), false);
  });
});

describe('getApprovedProposalEntityLinks', () => {
  it('returns links for approved update_task proposals', () => {
    const links = getApprovedProposalEntityLinks(
      [
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
      ],
      ACTIVE
    );
    assert.deepEqual(links, [
      {
        kind: 'task',
        id: 'task-2',
        label: 'Updated title',
        status: 'in_progress',
        percentComplete: 40,
      },
    ]);
  });

  it('deduplicates links already present on tool results', () => {
    const links = getApprovedProposalEntityLinks(
      [
        proposal({
          name: 'create_project',
          status: 'approved',
          stagedEntity: { kind: 'project', id: 'proj-new' },
          arguments: { name: 'New Workspace' },
        }),
      ],
      ACTIVE,
      undefined,
      [{ kind: 'project', id: 'proj-new', label: 'New Workspace' }]
    );
    assert.equal(links.length, 0);
  });

  it('returns create links when not already on tool results', () => {
    const links = getApprovedProposalEntityLinks(
      [
        proposal({
          name: 'create_project',
          status: 'approved',
          stagedEntity: { kind: 'project', id: 'proj-new' },
          arguments: { name: 'New Workspace' },
        }),
      ],
      ACTIVE
    );
    assert.deepEqual(links, [
      {
        kind: 'project',
        id: 'proj-new',
        label: 'New Workspace',
      },
    ]);
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

describe('aggregateDedupedEntityLinks', () => {
  it('dedupes the same task across multiple tool calls', () => {
    const task = { kind: 'task' as const, id: 't1', label: 'Advertise', projectId: 'p1' };
    const links = aggregateDedupedEntityLinks([
      { entityLinks: [task] },
      { entityLinks: [task] },
      { entityLinks: [task] },
    ]);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.label, 'Advertise');
  });

  it('preserves distinct tasks in order', () => {
    const links = aggregateDedupedEntityLinks([
      {
        entityLinks: [
          { kind: 'task', id: 't1', label: 'Sell Boxster', projectId: 'p1' },
          { kind: 'task', id: 't2', label: 'Advertise', projectId: 'p1' },
        ],
      },
      { entityLinks: [{ kind: 'task', id: 't2', label: 'Advertise', projectId: 'p1' }] },
    ]);
    assert.deepEqual(
      links.map((link) => link.id),
      ['t1', 't2']
    );
  });
});

describe('aggregatedEntityLinkHeading', () => {
  it('returns count headings for task lists', () => {
    assert.equal(
      aggregatedEntityLinkHeading([
        { kind: 'task', id: 't1', label: 'A' },
        { kind: 'task', id: 't2', label: 'B' },
      ]),
      '2 tasks found'
    );
  });

  it('returns null for a single project link', () => {
    assert.equal(
      aggregatedEntityLinkHeading([{ kind: 'project', id: 'p1', label: 'Boat' }]),
      null
    );
  });
});

describe('aggregatedEntityLinkHeadingForMessage', () => {
  it('returns null for multi-section create preflight messages', () => {
    assert.equal(
      aggregatedEntityLinkHeadingForMessage(
        [
          { kind: 'task', id: 't-new', label: 'Vacuum the car' },
          { kind: 'task', id: 't1', label: 'Wash the car' },
        ],
        [
          { name: 'create_task', success: true, entityLinks: [{ kind: 'task', id: 't-new', label: 'Vacuum the car' }] },
          { name: 'find_tasks', success: true, entityLinks: [{ kind: 'task', id: 't1', label: 'Wash the car' }] },
        ],
        undefined
      ),
      null
    );
  });

  it('keeps default heading for plain list_projects', () => {
    assert.equal(
      aggregatedEntityLinkHeadingForMessage(
        [
          { kind: 'project', id: 'p1', label: 'Boat' },
          { kind: 'project', id: 'p2', label: 'Sell Airplane' },
        ],
        [{ name: 'list_projects', success: true }],
        undefined
      ),
      '2 projects found'
    );
  });
});

describe('entityLinkSectionsFromToolCalls', () => {
  it('detects create-task preflight from tool calls', () => {
    assert.equal(
      isCreateTaskPreflightMessage([
        { name: 'create_task', success: true },
        { name: 'find_tasks', success: true },
      ]),
      true
    );
    assert.equal(
      isCreateTaskPreflightMessage([{ name: 'find_tasks', success: true }]),
      false
    );
  });

  it('splits create_task and find_tasks into New task and Similar existing tasks sections', () => {
    const sections = entityLinkSectionsFromToolCalls([
      {
        name: 'create_task',
        success: true,
        entityLinks: [{ kind: 'task', id: 't-new', label: 'Vacuum the car', projectId: ACTIVE }],
      },
      {
        name: 'find_tasks',
        success: true,
        entityLinks: [{ kind: 'task', id: 't1', label: 'Wash the car', projectId: ACTIVE }],
      },
    ]);

    assert.equal(sections.length, 2);
    assert.equal(sections[0]?.heading, 'New task');
    assert.deepEqual(sections[0]?.links.map((link) => link.id), ['t-new']);
    assert.equal(sections[1]?.heading, 'Similar existing task');
    assert.deepEqual(sections[1]?.links.map((link) => link.id), ['t1']);
  });

  it('shows Similar existing tasks while create_task is still pending (no create links yet)', () => {
    const sections = entityLinkSectionsFromToolCalls([
      { name: 'create_task', success: true, entityLinks: [] },
      {
        name: 'find_tasks',
        success: true,
        entityLinks: [
          { kind: 'task', id: 't1', label: 'Wash the car', projectId: ACTIVE },
          { kind: 'task', id: 't2', label: 'Clean windshield from sop', projectId: ACTIVE },
        ],
      },
    ]);

    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.heading, 'Similar existing tasks');
    assert.equal(sections[0]?.links.length, 2);
  });

  it('uses similar-project sections for create_project preflight', () => {
    const sections = entityLinkSectionsFromToolCalls([
      {
        name: 'create_project',
        success: true,
        entityLinks: [{ kind: 'project', id: 'p-new', label: 'Sell Boat' }],
      },
      {
        name: 'list_projects',
        success: true,
        entityLinks: [
          { kind: 'project', id: 'p1', label: 'Sell Airplane' },
          { kind: 'project', id: 'p2', label: 'Sell the Motorcycle' },
        ],
      },
    ]);

    assert.equal(sections.length, 2);
    assert.equal(sections[0]?.heading, 'New project');
    assert.equal(sections[1]?.heading, 'Similar existing projects');
  });

  it('keeps a single section for plain find_tasks listings', () => {
    const sections = entityLinkSectionsFromToolCalls([
      {
        name: 'find_tasks',
        success: true,
        entityLinks: [
          { kind: 'task', id: 't1', label: 'Clean windshield from sop', projectId: ACTIVE },
          { kind: 'task', id: 't2', label: 'Wash the car', projectId: ACTIVE },
        ],
      },
    ]);

    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.heading, '2 tasks found');
    assert.equal(sections[0]?.links.length, 2);
  });
});
