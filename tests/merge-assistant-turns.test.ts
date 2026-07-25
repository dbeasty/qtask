import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeAssistantTurns, mergeToolCalls } from '../client/src/utils/mergeAssistantTurns.ts';
import type { UiMessage } from '../client/src/types.ts';

describe('mergeAssistantTurns', () => {
  it('merges consecutive assistant messages after a user turn', () => {
    const messages: UiMessage[] = [
      { id: 'u1', role: 'user', content: 'show current project' },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            name: 'get_project',
            success: true,
            entityLinks: [{ kind: 'project', id: 'p1', label: 'Sell Airplane' }],
          },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        content: 'Here is your current project summary.',
      },
    ];

    const merged = mergeAssistantTurns(messages);
    assert.equal(merged.length, 2);
    assert.equal(merged[1]?.role, 'assistant');
    assert.equal(merged[1]?.content, 'Here is your current project summary.');
    assert.equal(merged[1]?.toolCalls?.length, 1);
    assert.equal(merged[1]?.toolCalls?.[0]?.entityLinks?.[0]?.label, 'Sell Airplane');
  });

  it('does not merge assistant messages from separate user turns', () => {
    const messages: UiMessage[] = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'Hi there.' },
      { id: 'u2', role: 'user', content: 'show tasks' },
      { id: 'a2', role: 'assistant', content: '', toolCalls: [{ name: 'find_tasks', success: true }] },
      { id: 'a3', role: 'assistant', content: 'Found 2 tasks.' },
    ];

    const merged = mergeAssistantTurns(messages);
    assert.equal(merged.length, 4);
    assert.equal(merged[1]?.content, 'Hi there.');
    assert.equal(merged[3]?.content, 'Found 2 tasks.');
    assert.equal(merged[3]?.toolCalls?.length, 1);
  });

  it('combines proposals and warnings across merged assistant turns', () => {
    const messages: UiMessage[] = [
      { id: 'u1', role: 'user', content: 'create task' },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        proposals: [{ id: 'p1', name: 'create_task', arguments: { title: 'A' }, source: 'native', status: 'pending' }],
        paused: true,
      },
      {
        id: 'a2',
        role: 'assistant',
        content: 'Ready for approval.',
        warnings: ['Note'],
      },
    ];

    const merged = mergeAssistantTurns(messages);
    assert.equal(merged.length, 2);
    assert.equal(merged[1]?.proposals?.length, 1);
    assert.equal(merged[1]?.warnings?.[0], 'Note');
    assert.equal(merged[1]?.paused, true);
  });
});

describe('mergeToolCalls', () => {
  it('maps enrichments onto stored tool calls', () => {
    const merged = mergeToolCalls(
      [{ function: { name: 'get_project', arguments: { projectId: 'p1' } } }],
      [
        {
          name: 'get_project',
          success: true,
          entityLinks: [{ kind: 'project', id: 'p1', label: 'Sell Airplane' }],
        },
      ]
    );

    assert.equal(merged?.length, 1);
    assert.equal(merged?.[0]?.entityLinks?.[0]?.label, 'Sell Airplane');
  });
});
