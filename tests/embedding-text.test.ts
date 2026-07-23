import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProjectEmbeddingText,
  buildTaskEmbeddingText,
} from '../src/services/embeddingService.js';

describe('embedding text builders', () => {
  it('buildTaskEmbeddingText includes tags, projects, and steps', () => {
    const text = buildTaskEmbeddingText({
      title: 'Fix faucet',
      description: 'Replace cartridge',
      tags: ['plumbing', 'urgent'],
      projectNames: ['Kitchen Remodel', 'Home Maintenance'],
      steps: [{ text: 'Shut off water' }, { text: 'Remove handle' }],
    });

    assert.match(text, /Fix faucet/);
    assert.match(text, /Replace cartridge/);
    assert.match(text, /Tags: plumbing, urgent/);
    assert.match(text, /Projects: Kitchen Remodel, Home Maintenance/);
    assert.match(text, /Steps:/);
    assert.match(text, /- Shut off water/);
    assert.match(text, /- Remove handle/);
  });

  it('buildProjectEmbeddingText includes name and description', () => {
    const text = buildProjectEmbeddingText({
      name: 'Kitchen Remodel',
      description: 'Main floor renovation',
    });

    assert.equal(text, 'Kitchen Remodel\nMain floor renovation');
  });
});
