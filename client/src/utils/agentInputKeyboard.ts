import type { KeyboardEvent } from 'react';

interface AgentInputKeyDownOptions {
  enterToSend: boolean;
  canSend: boolean;
  onSend: () => void;
}

export function handleAgentInputKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  { enterToSend, canSend, onSend }: AgentInputKeyDownOptions
): void {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;

  if (enterToSend) {
    if (event.altKey) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (canSend) onSend();
    return;
  }

  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    if (canSend) onSend();
  }
}
