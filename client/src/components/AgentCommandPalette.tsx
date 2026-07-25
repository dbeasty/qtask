import { useEffect, useId, useRef } from 'react';
import type { AgentCommandPaletteItem } from '../utils/agentCommandPalette';
import { COMMAND_PALETTE_HINT } from '../utils/agentCommandPalette';

interface AgentCommandPaletteProps {
  open: boolean;
  items: AgentCommandPaletteItem[];
  highlightIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (item: AgentCommandPaletteItem) => void;
}

export function AgentCommandPalette({
  open,
  items,
  highlightIndex,
  onHighlight,
  onSelect,
}: AgentCommandPaletteProps) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || items.length === 0) return;
    const option = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${highlightIndex}"]`
    );
    option?.scrollIntoView({ block: 'nearest' });
  }, [open, items.length, highlightIndex]);

  if (!open) return null;

  return (
    <div className="agent-command-palette" role="dialog" aria-label="Agent commands">
      <p className="agent-command-palette-hint">{COMMAND_PALETTE_HINT}</p>
      {items.length === 0 ? (
        <p className="agent-command-palette-empty">No matching commands</p>
      ) : (
        <div
          ref={listRef}
          id={listId}
          className="agent-command-palette-list"
          role="listbox"
          aria-activedescendant={`${listId}-option-${highlightIndex}`}
        >
          {items.map((item, index) => {
            const active = index === highlightIndex;
            return (
              <button
                key={item.id}
                type="button"
                id={`${listId}-option-${index}`}
                data-palette-index={index}
                role="option"
                aria-selected={active}
                className={`agent-command-palette-item${active ? ' is-active' : ''}`}
                onMouseEnter={() => onHighlight(index)}
                onClick={() => onSelect(item)}
              >
                <span className="agent-command-palette-item-goal">{item.goal}</span>
                <span className="agent-command-palette-item-example">{item.example}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
