import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayMessageContent } from '../client/src/utils/agentContent.ts';
import type { UiMessage } from '../client/src/types.ts';

describe('displayMessageContent read-tool stripping', () => {
  it('strips redundant project detail blocks when entity links exist', () => {
    const message: UiMessage = {
      id: 'a1',
      role: 'assistant',
      content: `I see you might be asking about the **Sell Airplane** project.

**Project:** Sell Airplane (ID: \`6a5c1eb550f0d2802bcfc010\`)
- Status: To Do | Percent Complete: 0%
- Description: Not specified yet
- Owner Email: msft_davja@hotmail.com

This is your most recent project.`,
      toolCalls: [
        {
          name: 'get_project',
          success: true,
          entityLinks: [
            {
              kind: 'project',
              id: '6a5c1eb550f0d2802bcfc010',
              label: 'Sell Airplane',
              status: 'todo',
              percentComplete: 0,
            },
          ],
        },
      ],
    };

    const content = displayMessageContent(message);
    assert.match(content, /most recent project/i);
    assert.doesNotMatch(content, /\*\*Project:\*\* Sell Airplane/i);
    assert.doesNotMatch(content, /Owner Email:/i);
  });

  it('strips numbered list_projects detail when entity links exist', () => {
    const message: UiMessage = {
      id: 'a3',
      role: 'assistant',
      content: `Here's an overview of your **current projects**:

**1. Boat** (ID: \`6a46d9090d546acbab8f8ac2\`) - In Progress | 70% Complete
- Description: Get ready boat for fun..
- Owner Email: msft_davja@hotmail.com

**2. Sell Airplane** (ID: \`6a5c1eb550f0d2802bcfc010\`) - To Do | 0% Complete
- Description: Not specified yet
- Owner Email: msft_davja@hotmail.com

All five projects are owned by you at **msft_davja@hotmail.com**. Your Boat project is currently in progress.`,
      toolCalls: [
        {
          name: 'list_projects',
          success: true,
          entityLinks: [
            { kind: 'project', id: '6a46d9090d546acbab8f8ac2', label: 'Boat', status: 'in_progress', percentComplete: 70 },
            { kind: 'project', id: '6a5c1eb550f0d2802bcfc010', label: 'Sell Airplane', status: 'todo', percentComplete: 0 },
          ],
        },
      ],
    };

    const content = displayMessageContent(message);
    assert.match(content, /overview of your/i);
    assert.doesNotMatch(content, /\*\*1\. Boat\*\*/i);
    assert.doesNotMatch(content, /Sell Airplane/i);
    assert.doesNotMatch(content, /Owner Email:/i);
    assert.doesNotMatch(content, /All five projects are owned/i);
  });

  it('leaves proposal-only stripping behavior unchanged', () => {
    const message: UiMessage = {
      id: 'a2',
      role: 'assistant',
      content: 'Here is the corrected task:',
      proposals: [
        {
          id: 'p1',
          name: 'update_task',
          arguments: { taskId: 't1', title: 'Updated' },
          source: 'native',
          status: 'pending',
        },
      ],
    };

    assert.equal(displayMessageContent(message), '');
  });

  it('strips create_task confirmation prose when approved proposal links exist', () => {
    const message: UiMessage = {
      id: 'a4',
      role: 'assistant',
      content:
        'Task **`6a6512273f09106f6a8f4c69`: "Put advertisement on Barnstormers"** has been created and committed to your Sell Airplane project.',
      proposals: [
        {
          id: 'p1',
          name: 'create_task',
          arguments: { title: 'Put advertisement on Barnstormers', projectId: 'proj-active' },
          source: 'native',
          status: 'approved',
          stagedEntity: { kind: 'task', id: '6a6512273f09106f6a8f4c69' },
        },
      ],
    };

    const content = displayMessageContent(message, {
      activeProjectId: 'proj-active',
      resolveProjectLabel: (id) => (id === 'proj-active' ? 'Sell Airplane' : undefined),
    });
    assert.equal(content, '');
  });

  it('strips superseded not-found prose when create_project entity links exist', () => {
    const message: UiMessage = {
      id: 'a5',
      role: 'assistant',
      content: 'No project named "sell boxster" found.',
      toolCalls: [
        {
          name: 'create_project',
          success: true,
          entityLinks: [{ kind: 'project', id: 'proj-new', label: 'sell boxster' }],
        },
      ],
      proposals: [
        {
          id: 'p1',
          name: 'create_project',
          arguments: { name: 'sell boxster' },
          source: 'native',
          status: 'pending',
          staged: true,
          stagedEntity: { kind: 'project', id: 'proj-new' },
        },
      ],
    };

    assert.equal(displayMessageContent(message), '');
  });
});
