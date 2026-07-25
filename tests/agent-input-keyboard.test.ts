import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleAgentInputKeyDown } from '../client/src/utils/agentInputKeyboard.ts';

function createKeyDownEvent(
  key: string,
  modifiers: { altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}
) {
  let defaultPrevented = false;
  const event = {
    key,
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    nativeEvent: { isComposing: false },
    preventDefault() {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  };
  return event as Parameters<typeof handleAgentInputKeyDown>[0] & { defaultPrevented: boolean };
}

describe('handleAgentInputKeyDown', () => {
  it('sends on Enter when enter-to-send is enabled', () => {
    let sent = false;
    const event = createKeyDownEvent('Enter');
    handleAgentInputKeyDown(event, {
      enterToSend: true,
      canSend: true,
      onSend: () => {
        sent = true;
      },
    });
    assert.equal(sent, true);
    assert.equal(event.defaultPrevented, true);
  });

  it('inserts a newline on Alt+Enter when enter-to-send is enabled', () => {
    let sent = false;
    const event = createKeyDownEvent('Enter', { altKey: true });
    handleAgentInputKeyDown(event, {
      enterToSend: true,
      canSend: true,
      onSend: () => {
        sent = true;
      },
    });
    assert.equal(sent, false);
    assert.equal(event.defaultPrevented, false);
  });

  it('sends on Ctrl+Enter when enter-to-send is disabled', () => {
    let sent = false;
    const event = createKeyDownEvent('Enter', { ctrlKey: true });
    handleAgentInputKeyDown(event, {
      enterToSend: false,
      canSend: true,
      onSend: () => {
        sent = true;
      },
    });
    assert.equal(sent, true);
    assert.equal(event.defaultPrevented, true);
  });

  it('does not send on plain Enter when enter-to-send is disabled', () => {
    let sent = false;
    const event = createKeyDownEvent('Enter');
    handleAgentInputKeyDown(event, {
      enterToSend: false,
      canSend: true,
      onSend: () => {
        sent = true;
      },
    });
    assert.equal(sent, false);
    assert.equal(event.defaultPrevented, false);
  });
});
