import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_AGENT_PROMPT,
  DEMO_STEPS,
  getDemoStepIds,
  getDemoStepSelectors,
} from '../client/src/components/DemoTour/demoSteps.ts';

describe('demoSteps', () => {
  it('defines stable selectors for every step', () => {
    assert.ok(DEMO_STEPS.length >= 6);
    for (const step of DEMO_STEPS) {
      assert.match(step.selector, /^\[data-demo-step="[^"]+"\]$/);
      assert.ok(step.title.trim().length > 0);
      assert.ok(step.description.trim().length > 0);
    }
  });

  it('exposes unique step ids and selectors', () => {
    const ids = getDemoStepIds();
    const selectors = getDemoStepSelectors();
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(selectors).size, selectors.length);
    assert.equal(ids.length, DEMO_STEPS.length);
  });

  it('includes an agent demo prompt', () => {
    assert.match(DEMO_AGENT_PROMPT, /onboarding tasks/i);
    assert.ok(DEMO_STEPS.some((step) => step.prefillAgentPrompt));
  });
});
