import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';

describe('KNOWN_TOOL_NAMES stays in sync with toolDefinitions', () => {
  it('includes every tool defined in tools.ts, not a hand-maintained subset', async () => {
    const { KNOWN_TOOL_NAMES } = await import('../src/agent/toolPolicy.js');
    const { toolDefinitions } = await import('../src/agent/tools.js');

    const definedNames = toolDefinitions.map((tool) => tool.name).sort();
    assert.deepEqual([...KNOWN_TOOL_NAMES].sort(), definedNames);

    // These two tools existed in toolDefinitions but were missing from the
    // old hand-maintained KNOWN_TOOL_NAMES array — the exact drift this fix
    // closes.
    assert.ok(KNOWN_TOOL_NAMES.includes('add_comment'));
    assert.ok(KNOWN_TOOL_NAMES.includes('get_project_tracking'));
  });

  it('parseTextToolCalls recognizes a JSON tool call for a tool absent from the old hardcoded list', async () => {
    const { parseTextToolCalls } = await import('../src/agent/parseTextToolCall.js');

    const text = JSON.stringify({
      name: 'add_comment',
      parameters: { taskId: '507f1f77bcf86cd799439011', body: 'Looks good to me' },
    });

    const parsed = parseTextToolCalls(text);
    assert.equal(parsed.length, 1, `expected the add_comment call to be recognized, got: ${JSON.stringify(parsed)}`);
    assert.equal(parsed[0]?.name, 'add_comment');
  });

  it('contentMentionsToolCall recognizes a tool absent from the old hardcoded list', async () => {
    const { contentMentionsToolCall } = await import('../src/agent/parseTextToolCall.js');

    assert.equal(contentMentionsToolCall('I will call get_project_tracking to check status.'), true);
  });
});
