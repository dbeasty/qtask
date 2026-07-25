import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { slimProjectForTool, slimTaskForTool } from '../src/utils/serialization.ts';
import {
  buildMessageToolResults,
  entityLinksFromToolResult,
  filterTaskLinksByProject,
  updateHighlightedProjectId,
} from '../src/utils/toolEntityLinks.ts';

describe('slimTaskForTool', () => {
  it('strips embedding and nested fields', () => {
    const slim = slimTaskForTool({
      _id: 'abc123',
      title: 'Sell plane',
      status: 'todo',
      priority: 'medium',
      percentComplete: 0,
      projectIds: ['proj1'],
      embedding: Array.from({ length: 201 }, (_, i) => i),
      materials: [{ description: 'part', quantity: 1, unitPrice: 10 }],
      subtasks: [{ _id: 'sub1', title: 'Sub', subtasks: [] }],
      __v: 3,
    });

    assert.equal(slim._id, 'abc123');
    assert.equal(slim.title, 'Sell plane');
    assert.equal(slim.projectId, 'proj1');
    assert.equal(slim.subtaskCount, 1);
    assert.equal('embedding' in slim, false);
    assert.equal('materials' in slim, false);
    assert.equal('subtasks' in slim, false);
  });
});

describe('slimProjectForTool', () => {
  it('keeps listing fields only', () => {
    const slim = slimProjectForTool({
      _id: 'proj1',
      name: 'Sell Airplane',
      status: 'todo',
      percentComplete: 0,
      description: 'List it',
      ownerEmail: 'user@example.com',
      canEdit: true,
      collaborators: [{ userId: 'x', email: 'x@y.com', role: 'editor' }],
    });

    assert.deepEqual(slim, {
      _id: 'proj1',
      name: 'Sell Airplane',
      status: 'todo',
      percentComplete: 0,
      description: 'List it',
      ownerEmail: 'user@example.com',
    });
  });
});

describe('entityLinksFromToolResult', () => {
  it('maps find_tasks results', () => {
    const content = JSON.stringify({
      count: 1,
      tasks: [
        {
          _id: 'task1',
          title: 'Clean hangar',
          status: 'todo',
          percentComplete: 0,
          projectIds: ['proj1'],
        },
      ],
    });

    assert.deepEqual(entityLinksFromToolResult('find_tasks', content, true), [
      {
        kind: 'task',
        id: 'task1',
        label: 'Clean hangar',
        status: 'todo',
        percentComplete: 0,
        projectId: 'proj1',
      },
    ]);
  });

  it('maps list_projects results', () => {
    const content = JSON.stringify({
      count: 1,
      projects: [
        {
          _id: 'proj1',
          name: 'Sell Airplane',
          status: 'in_progress',
          percentComplete: 25,
        },
      ],
    });

    assert.deepEqual(entityLinksFromToolResult('list_projects', content, true), [
      {
        kind: 'project',
        id: 'proj1',
        label: 'Sell Airplane',
        status: 'in_progress',
        percentComplete: 25,
      },
    ]);
  });

  it('maps get_workload results', () => {
    const content = JSON.stringify({
      count: 1,
      workload: [
        {
          _id: 'task2',
          title: 'Inspect engine',
          status: 'in_progress',
          percentComplete: 50,
          projectId: 'proj2',
        },
      ],
    });

    assert.deepEqual(entityLinksFromToolResult('get_workload', content, true), [
      {
        kind: 'task',
        id: 'task2',
        label: 'Inspect engine',
        status: 'in_progress',
        percentComplete: 50,
        projectId: 'proj2',
      },
    ]);
  });

  it('maps get_task single object', () => {
    const content = JSON.stringify({
      _id: 'task3',
      title: 'Single task',
      status: 'done',
      percentComplete: 100,
      projectIds: ['proj3'],
    });

    assert.deepEqual(entityLinksFromToolResult('get_task', content, true), [
      {
        kind: 'task',
        id: 'task3',
        label: 'Single task',
        status: 'done',
        percentComplete: 100,
        projectId: 'proj3',
      },
    ]);
  });

  it('returns undefined on failure', () => {
    assert.equal(entityLinksFromToolResult('find_tasks', 'Task not found', false), undefined);
  });

  it('returns undefined for unsupported tools', () => {
    assert.equal(entityLinksFromToolResult('update_task', '{"ok":true}', true), undefined);
  });

  it('parses JSON before recovery guidance suffix', () => {
    const content = `${JSON.stringify({
      count: 1,
      tasks: [{ _id: 'task4', title: 'Recovered', status: 'todo', percentComplete: 0, projectIds: ['p1'] }],
    })}\n\nRECOVERY: use real ids`;

    assert.deepEqual(entityLinksFromToolResult('find_tasks', content, true), [
      {
        kind: 'task',
        id: 'task4',
        label: 'Recovered',
        status: 'todo',
        percentComplete: 0,
        projectId: 'p1',
      },
    ]);
  });

  it('maps get_project single object', () => {
    const content = JSON.stringify({
      _id: 'proj1',
      name: 'Boat',
      status: 'in_progress',
      percentComplete: 70,
    });

    assert.deepEqual(entityLinksFromToolResult('get_project', content, true), [
      {
        kind: 'project',
        id: 'proj1',
        label: 'Boat',
        status: 'in_progress',
        percentComplete: 70,
      },
    ]);
  });

  it('maps summarize_project from slim project JSON source', () => {
    const content = JSON.stringify({
      _id: 'proj2',
      name: 'Smart For Two',
      status: 'todo',
      percentComplete: 0,
    });

    assert.deepEqual(entityLinksFromToolResult('summarize_project', content, true), [
      {
        kind: 'project',
        id: 'proj2',
        label: 'Smart For Two',
        status: 'todo',
        percentComplete: 0,
      },
    ]);
  });

  it('filters find_tasks by scope projectId', () => {
    const content = JSON.stringify({
      count: 2,
      tasks: [
        { _id: 't1', title: 'Boat task', status: 'todo', percentComplete: 0, projectIds: ['boat'] },
        { _id: 't2', title: 'Car task', status: 'todo', percentComplete: 0, projectIds: ['car'] },
      ],
    });

    const links = entityLinksFromToolResult('find_tasks', content, true, 'boat');
    assert.equal(links?.length, 1);
    assert.equal(links?.[0]?.id, 't1');
  });

  it('returns all tasks when no scope projectId', () => {
    const content = JSON.stringify({
      count: 2,
      tasks: [
        { _id: 't1', title: 'A', status: 'todo', percentComplete: 0, projectIds: ['p1'] },
        { _id: 't2', title: 'B', status: 'todo', percentComplete: 0, projectIds: ['p2'] },
      ],
    });

    assert.equal(entityLinksFromToolResult('find_tasks', content, true)?.length, 2);
  });
});

describe('updateHighlightedProjectId', () => {
  it('sets scope from get_project entity link', () => {
    const links = [{ kind: 'project' as const, id: 'boat', label: 'Boat' }];
    const scope = updateHighlightedProjectId(undefined, 'get_project', {}, true, links);
    assert.equal(scope, 'boat');
  });

  it('sets scope from find_tasks projectId arg', () => {
    const scope = updateHighlightedProjectId(undefined, 'find_tasks', { projectId: 'boat' }, true, []);
    assert.equal(scope, 'boat');
  });
});

describe('filterTaskLinksByProject', () => {
  it('keeps project links and matching tasks', () => {
    const links = [
      { kind: 'project' as const, id: 'boat', label: 'Boat' },
      { kind: 'task' as const, id: 't1', label: 'Wash', projectId: 'boat' },
      { kind: 'task' as const, id: 't2', label: 'Other', projectId: 'car' },
    ];
    const filtered = filterTaskLinksByProject(links, 'boat');
    assert.equal(filtered.length, 2);
    assert.equal(filtered[1]?.id, 't1');
  });
});

describe('buildMessageToolResults', () => {
  it('matches tool results to assistant tool calls in order', () => {
    const messages = [
      { role: 'user', content: 'show tasks' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { function: { name: 'find_tasks', arguments: {} } },
          { function: { name: 'find_tasks', arguments: {} } },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({
          count: 1,
          tasks: [{ _id: 't1', title: 'First', status: 'todo', percentComplete: 0, projectIds: ['p1'] }],
        }),
        toolName: 'find_tasks',
      },
      {
        role: 'tool',
        content: JSON.stringify({
          count: 1,
          tasks: [{ _id: 't2', title: 'Second', status: 'todo', percentComplete: 0, projectIds: ['p2'] }],
        }),
        toolName: 'find_tasks',
      },
      { role: 'assistant', content: 'Found two sets.' },
    ];

    const results = buildMessageToolResults(messages);
    assert.equal(results[1]?.length, 2);
    assert.equal(results[1]?.[0]?.entityLinks?.[0]?.id, 't1');
    assert.equal(results[1]?.[1]?.entityLinks?.[0]?.id, 't2');
  });

  it('uses entityLinkSource for summarize_project tool messages', () => {
    const slimProject = JSON.stringify({
      _id: 'proj9',
      name: 'Boat',
      status: 'in_progress',
      percentComplete: 70,
    });
    const messages = [
      { role: 'user', content: 'summarize current project' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ function: { name: 'summarize_project', arguments: { projectId: 'proj9' } } }],
      },
      {
        role: 'tool',
        content: 'Project Boat is 70% complete with several open tasks.',
        toolName: 'summarize_project',
        entityLinkSource: slimProject,
      },
      { role: 'assistant', content: 'Here is the summary.' },
    ];

    const results = buildMessageToolResults(messages);
    assert.deepEqual(results[1]?.[0]?.entityLinks, [
      {
        kind: 'project',
        id: 'proj9',
        label: 'Boat',
        status: 'in_progress',
        percentComplete: 70,
      },
    ]);
  });

  it('scopes find_tasks to prior get_project in same turn', () => {
    const boatProject = JSON.stringify({
      _id: 'boat-proj',
      name: 'Boat',
      status: 'in_progress',
      percentComplete: 50,
    });
    const findTasks = JSON.stringify({
      count: 2,
      tasks: [
        { _id: 't1', title: 'Wash boat', status: 'todo', percentComplete: 0, projectIds: ['boat-proj'] },
        { _id: 't2', title: 'Wash car', status: 'todo', percentComplete: 0, projectIds: ['car-proj'] },
      ],
    });
    const messages = [
      { role: 'user', content: 'open tasks in Boat project' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ function: { name: 'get_project', arguments: { projectId: 'boat-proj' } } }],
      },
      { role: 'tool', content: boatProject, toolName: 'get_project' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ function: { name: 'find_tasks', arguments: { query: 'open' } } }],
      },
      { role: 'tool', content: findTasks, toolName: 'find_tasks' },
      { role: 'assistant', content: 'Here are the open tasks.' },
    ];

    const results = buildMessageToolResults(messages);
    assert.equal(results[1]?.[0]?.entityLinks?.[0]?.kind, 'project');
    assert.equal(results[2]?.[0]?.entityLinks?.length, 1);
    assert.equal(results[2]?.[0]?.entityLinks?.[0]?.id, 't1');
  });
});
