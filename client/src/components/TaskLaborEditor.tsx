import { useEffect, useRef, useState } from 'react';
import type { LaborLine } from '../types';
import { formatMoney } from '../utils/costRollup';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

function isPersistedId(id?: string): boolean {
  return Boolean(id && OBJECT_ID_RE.test(id));
}

function ensureClientKey(line: LaborLine): LaborLine {
  if (line.clientKey) return line;
  return {
    ...line,
    clientKey:
      line._id && isPersistedId(line._id) ? `server-${line._id}` : `ck-${crypto.randomUUID()}`,
  };
}

export function newDraftLaborLine(): LaborLine {
  const clientKey = `ck-${crypto.randomUUID()}`;
  return {
    _id: `draft-${crypto.randomUUID()}`,
    clientKey,
    description: '',
    hours: 0,
  };
}

function laborRowKey(line: LaborLine, index: number): string {
  return line.clientKey ?? line._id ?? `labor-${index}`;
}

function displayHoursValue(
  line: LaborLine,
  rowKey: string,
  drafts: Record<string, string>
): string {
  const draftKey = `${rowKey}:hours`;
  if (draftKey in drafts) return drafts[draftKey];
  const value = Number(line.hours) || 0;
  return value === 0 ? '' : String(value);
}

function parseHours(raw: string): number {
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export function laborLinesForApi(laborLines: LaborLine[]) {
  return laborLines
    .map((line) => ({
      ...(line._id && isPersistedId(line._id) ? { _id: line._id } : {}),
      description: line.description?.trim() || undefined,
      hours: Number(line.hours) || 0,
    }))
    .filter((line) => line.hours > 0);
}

export function sumLaborHours(laborLines: LaborLine[]): number {
  return laborLines.reduce((sum, line) => sum + (Number(line.hours) || 0), 0);
}

export function laborLinesEqualForSave(a: LaborLine[], b: LaborLine[]): boolean {
  return JSON.stringify(laborLinesForApi(a)) === JSON.stringify(laborLinesForApi(b));
}

export function laborLinesSyncedEqual(a: LaborLine[], b: LaborLine[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, index) => {
    const other = b[index];
    if (!other) return false;
    return (
      (line.description ?? '') === (other.description ?? '') &&
      Number(line.hours) === Number(other.hours)
    );
  });
}

export function mergeLocalLaborLines(saved: LaborLine[], local: LaborLine[]): LaborLine[] {
  const localByKey = new Map(local.map((line) => [line.clientKey ?? line._id ?? '', line]));
  return saved.map((line) => {
    const key = line.clientKey ?? line._id ?? '';
    const localLine = localByKey.get(key);
    if (!localLine) return ensureClientKey(line);
    return ensureClientKey({ ...line, ...localLine, _id: line._id ?? localLine._id });
  });
}

export function laborLinesFromTask(
  laborLines?: LaborLine[],
  hoursSpent?: number
): LaborLine[] {
  const fromServer = (laborLines ?? []).map((line) => ({
    ...line,
    clientKey: line.clientKey ?? (line._id ? `server-${line._id}` : undefined),
  }));
  if (fromServer.length > 0) return fromServer;
  if (hoursSpent !== undefined && hoursSpent > 0) {
    return [
      ensureClientKey({
        _id: `migrated-${crypto.randomUUID()}`,
        description: 'Prior total',
        hours: hoursSpent,
      }),
    ];
  }
  return [];
}

interface TaskLaborEditorProps {
  laborLines: LaborLine[];
  hoursRemaining: string;
  effectiveHourlyRate: number;
  onLaborChange: (updater: (lines: LaborLine[]) => LaborLine[]) => void;
  onHoursRemainingChange: (value: string) => void;
  onRateClick: () => void;
  onCommit?: () => void;
  disabled?: boolean;
}

export function TaskLaborEditor({
  laborLines,
  hoursRemaining,
  effectiveHourlyRate,
  onLaborChange,
  onHoursRemainingChange,
  onRateClick,
  onCommit,
  disabled = false,
}: TaskLaborEditorProps) {
  const [focusClientKey, setFocusClientKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [estimatedDraft, setEstimatedDraft] = useState<string | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  useEffect(() => {
    if (!focusClientKey) return;
    const input = inputRefs.current.get(focusClientKey);
    input?.focus();
    setFocusClientKey(null);
  }, [focusClientKey, laborLines.length]);

  const updateLaborLines = (updater: (current: LaborLine[]) => LaborLine[]) => {
    onLaborChange((current) => updater(current.map(ensureClientKey)));
  };

  const updateLine = (index: number, patch: Partial<LaborLine>) => {
    updateLaborLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line))
    );
  };

  const removeLine = (index: number) => {
    updateLaborLines((current) => current.filter((_, i) => i !== index));
    onCommit?.();
  };

  const addLine = () => {
    const draft = newDraftLaborLine();
    updateLaborLines((current) => [...current, draft]);
    setFocusClientKey(draft.clientKey ?? draft._id ?? null);
  };

  const commitHoursField = (index: number, rowKey: string) => {
    const draftKey = `${rowKey}:hours`;
    const raw = drafts[draftKey];
    if (raw !== undefined) {
      updateLine(index, { hours: parseHours(raw) });
      setDrafts((current) => {
        if (!(draftKey in current)) return current;
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
    }
    onCommit?.();
  };

  const spentTotal = sumLaborHours(laborLines);
  const showList = laborLines.length > 0;
  const estimatedDisplay =
    estimatedDraft !== null ? estimatedDraft : hoursRemaining.trim() ? hoursRemaining : '';
  const hasSpent = spentTotal > 0;
  const hasEstimate =
    estimatedDraft !== null || (hoursRemaining.trim() !== '' && parseHours(hoursRemaining) > 0);
  const showFooter = hasSpent || hasEstimate || estimatedDraft !== null;

  return (
    <div className="task-labor-editor">
      <div className="task-tracking-add-row">
        {!disabled && (
          <button type="button" className="primary-button task-steps-add" onClick={addLine}>
            + Add hours
          </button>
        )}
        <button
          type="button"
          className="task-tracking-rate"
          onClick={onRateClick}
          disabled={disabled}
        >
          {effectiveHourlyRate > 0 ? `$${formatMoney(effectiveHourlyRate)}/hr` : 'Set rate'}
        </button>
      </div>

      {showList && (
        <div className="task-labor-list">
          <div className="task-labor-columns" aria-hidden="true">
            <span>Note</span>
            <span>Hours</span>
            <span />
          </div>
          {laborLines.map((line, index) => {
            const key = laborRowKey(line, index);
            return (
              <div key={key} className="task-labor-row">
                <input
                  ref={(el) => {
                    if (el) inputRefs.current.set(key, el);
                    else inputRefs.current.delete(key);
                  }}
                  type="text"
                  className="task-labor-description"
                  value={line.description ?? ''}
                  placeholder="Note"
                  disabled={disabled}
                  onChange={(event) => updateLine(index, { description: event.target.value })}
                  onBlur={() => onCommit?.()}
                />
                <input
                  type="text"
                  inputMode="decimal"
                  className="task-labor-hours"
                  value={displayHoursValue(line, key, drafts)}
                  placeholder="0"
                  disabled={disabled}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [`${key}:hours`]: event.target.value }))
                  }
                  onFocus={(event) => event.target.select()}
                  onBlur={() => commitHoursField(index, key)}
                />
                {!disabled && (
                  <button
                    type="button"
                    className="task-labor-remove"
                    aria-label="Remove labor line"
                    onClick={() => removeLine(index)}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showFooter && (
        <div className="task-labor-footer">
          {hasSpent && <span className="task-labor-spent">Spent {spentTotal}h</span>}
          {(hasEstimate || hasSpent || estimatedDraft !== null) && (
            <label className="task-labor-estimated">
              <span>Estimated</span>
              <input
                type="text"
                inputMode="decimal"
                value={estimatedDisplay}
                placeholder=""
                disabled={disabled}
                onChange={(event) => setEstimatedDraft(event.target.value)}
                onFocus={() => setEstimatedDraft(hoursRemaining)}
                onBlur={() => {
                  if (estimatedDraft !== null) {
                    onHoursRemainingChange(estimatedDraft);
                    setEstimatedDraft(null);
                  }
                  onCommit?.();
                }}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
