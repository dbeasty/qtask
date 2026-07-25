import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_INSTRUCTIONS } from './fixtures/agentInstructions.ts';
import {
  applyInstructionSelection,
  buildAgentCommandPaletteItems,
  clampPaletteHighlightIndex,
  filterAgentCommandPaletteItems,
  isCommandPaletteOpen,
  parseSlashCommand,
  resolveCommandPaletteKeyDown,
} from '../client/src/utils/agentCommandPalette.ts';

describe('agent command palette utils', () => {
  it('builds searchable items from the instruction catalog', () => {
    const items = buildAgentCommandPaletteItems(AGENT_INSTRUCTIONS);
    assert.equal(items.length, AGENT_INSTRUCTIONS.length);
    assert.ok(items.some((item) => item.id === 'create-project'));
  });

  it('detects slash command mode', () => {
    assert.equal(parseSlashCommand('/create')?.query, 'create');
    assert.equal(parseSlashCommand('  /task')?.query, 'task');
    assert.equal(parseSlashCommand('create project'), null);
    assert.equal(isCommandPaletteOpen('/'), true);
    assert.equal(isCommandPaletteOpen('hello'), false);
  });

  it('filters items by slash query', () => {
    const items = buildAgentCommandPaletteItems(AGENT_INSTRUCTIONS);
    const filtered = filterAgentCommandPaletteItems(items, 'cre');
    assert.ok(filtered.some((item) => item.id === 'create-project'));
    assert.ok(filtered.some((item) => item.id === 'create-subproject'));
    assert.equal(filterAgentCommandPaletteItems(items, 'xyz').length, 0);
  });

  it('inserts the catalog example phrase on selection', () => {
    const item = buildAgentCommandPaletteItems(AGENT_INSTRUCTIONS).find(
      (entry) => entry.id === 'add-task'
    );
    assert.ok(item);
    assert.equal(applyInstructionSelection(item), 'add a task to Schedule inspection');
  });

  it('wraps palette highlight indices', () => {
    assert.equal(clampPaletteHighlightIndex(-1, 3), 2);
    assert.equal(clampPaletteHighlightIndex(3, 3), 0);
  });

  it('handles palette keyboard actions before send-on-enter', () => {
    assert.deepEqual(
      resolveCommandPaletteKeyDown('ArrowDown', {
        paletteOpen: true,
        hasItems: true,
        hasHighlight: true,
      }),
      { type: 'move', delta: 1 }
    );
    assert.deepEqual(
      resolveCommandPaletteKeyDown('Enter', {
        paletteOpen: true,
        hasItems: true,
        hasHighlight: true,
      }),
      { type: 'accept' }
    );
    assert.deepEqual(
      resolveCommandPaletteKeyDown('Enter', {
        paletteOpen: false,
        hasItems: true,
        hasHighlight: true,
      }),
      { type: 'pass' }
    );
    assert.deepEqual(
      resolveCommandPaletteKeyDown('Escape', {
        paletteOpen: true,
        hasItems: false,
        hasHighlight: false,
      }),
      { type: 'close' }
    );
  });
});
