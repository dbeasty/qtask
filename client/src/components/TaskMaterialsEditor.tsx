import { useEffect, useRef, useState } from 'react';
import type { MaterialLine } from '../types';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

function isPersistedId(id?: string): boolean {
  return Boolean(id && OBJECT_ID_RE.test(id));
}

function ensureClientKey(line: MaterialLine): MaterialLine {
  if (line.clientKey) return line;
  return {
    ...line,
    clientKey:
      line._id && isPersistedId(line._id) ? `server-${line._id}` : `ck-${crypto.randomUUID()}`,
  };
}

export function newDraftMaterial(): MaterialLine {
  const clientKey = `ck-${crypto.randomUUID()}`;
  return {
    _id: `draft-${crypto.randomUUID()}`,
    clientKey,
    description: '',
    quantity: 0,
    unitPrice: 0,
  };
}

function materialRowKey(line: MaterialLine, index: number): string {
  return line.clientKey ?? line._id ?? `material-${index}`;
}

type NumericField = 'quantity' | 'unitPrice';

function numericDraftKey(rowKey: string, field: NumericField): string {
  return `${rowKey}:${field}`;
}

function storedNumericValue(line: MaterialLine, field: NumericField): number {
  return Number(field === 'quantity' ? line.quantity : line.unitPrice) || 0;
}

function displayNumericValue(
  line: MaterialLine,
  field: NumericField,
  rowKey: string,
  drafts: Record<string, string>
): string {
  const draftKey = numericDraftKey(rowKey, field);
  if (draftKey in drafts) return drafts[draftKey];
  const value = storedNumericValue(line, field);
  return value === 0 ? '' : String(value);
}

function parseQuantity(raw: string): number {
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

function parseUnitPrice(raw: string): number {
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

export function materialsForApi(materials: MaterialLine[]) {
  return materials
    .map((line) => ({
      ...(line._id && isPersistedId(line._id) ? { _id: line._id } : {}),
      description: line.description.trim(),
      quantity: Number(line.quantity) || 0,
      unitPrice: Number(line.unitPrice) || 0,
    }))
    .filter((line) => line.description.length > 0);
}

export function materialsEqualForSave(a: MaterialLine[], b: MaterialLine[]): boolean {
  const aApi = materialsForApi(a);
  const bApi = materialsForApi(b);
  return JSON.stringify(aApi) === JSON.stringify(bApi);
}

export function materialsSyncedEqual(a: MaterialLine[], b: MaterialLine[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, index) => {
    const other = b[index];
    if (!other) return false;
    return (
      line.description === other.description &&
      Number(line.quantity) === Number(other.quantity) &&
      Number(line.unitPrice) === Number(other.unitPrice)
    );
  });
}

export function mergeLocalMaterials(saved: MaterialLine[], local: MaterialLine[]): MaterialLine[] {
  const localByKey = new Map(
    local.map((line) => [line.clientKey ?? line._id ?? '', line])
  );
  return saved.map((line) => {
    const key = line.clientKey ?? line._id ?? '';
    const localLine = localByKey.get(key);
    if (!localLine) return ensureClientKey(line);
    return ensureClientKey({ ...line, ...localLine, _id: line._id ?? localLine._id });
  });
}

interface TaskMaterialsEditorProps {
  materials: MaterialLine[];
  onChange: (updater: (materials: MaterialLine[]) => MaterialLine[]) => void;
  onCommit?: () => void;
  disabled?: boolean;
}

export function TaskMaterialsEditor({
  materials,
  onChange,
  onCommit,
  disabled = false,
}: TaskMaterialsEditorProps) {
  const [focusClientKey, setFocusClientKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  useEffect(() => {
    if (!focusClientKey) return;
    const input = inputRefs.current.get(focusClientKey);
    input?.focus();
    setFocusClientKey(null);
  }, [focusClientKey, materials.length]);

  const updateMaterials = (updater: (current: MaterialLine[]) => MaterialLine[]) => {
    onChange((current) => updater(current.map(ensureClientKey)));
  };

  const updateLine = (index: number, patch: Partial<MaterialLine>) => {
    updateMaterials((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line))
    );
  };

  const removeLine = (index: number) => {
    updateMaterials((current) => current.filter((_, i) => i !== index));
    onCommit?.();
  };

  const addLine = () => {
    const draft = newDraftMaterial();
    updateMaterials((current) => [...current, draft]);
    setFocusClientKey(draft.clientKey ?? draft._id ?? null);
  };

  const setDraft = (rowKey: string, field: NumericField, value: string) => {
    const draftKey = numericDraftKey(rowKey, field);
    setDrafts((current) => ({ ...current, [draftKey]: value }));
  };

  const clearDraft = (rowKey: string, field: NumericField) => {
    const draftKey = numericDraftKey(rowKey, field);
    setDrafts((current) => {
      if (!(draftKey in current)) return current;
      const next = { ...current };
      delete next[draftKey];
      return next;
    });
  };

  const commitNumericField = (index: number, rowKey: string, field: NumericField) => {
    const draftKey = numericDraftKey(rowKey, field);
    const raw = drafts[draftKey];
    if (raw !== undefined) {
      const parsed =
        field === 'quantity' ? parseQuantity(raw) : parseUnitPrice(raw);
      updateLine(index, { [field]: parsed });
      clearDraft(rowKey, field);
    }
    onCommit?.();
  };

  return (
    <div className="task-materials-editor">
      <div className="task-tracking-add-row">
        {!disabled && (
          <button type="button" className="primary-button task-steps-add" onClick={addLine}>
            + Add materials
          </button>
        )}
      </div>
      {materials.length > 0 && (
        <div className="task-materials-list">
          <div className="task-materials-columns" aria-hidden="true">
            <span>Description</span>
            <span>Qty</span>
            <span>Unit price</span>
            <span>Total</span>
            <span />
          </div>
          {materials.map((line, index) => {
            const key = materialRowKey(line, index);
            const lineTotal = (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0);
            return (
              <div key={key} className="task-materials-row">
                <input
                  ref={(el) => {
                    if (el) inputRefs.current.set(key, el);
                    else inputRefs.current.delete(key);
                  }}
                  type="text"
                  className="task-materials-description"
                  value={line.description}
                  placeholder="Description"
                  disabled={disabled}
                  onChange={(event) => updateLine(index, { description: event.target.value })}
                  onBlur={() => onCommit?.()}
                />
                <input
                  type="text"
                  inputMode="numeric"
                  className="task-materials-qty"
                  value={displayNumericValue(line, 'quantity', key, drafts)}
                  placeholder="Qty"
                  disabled={disabled}
                  onChange={(event) => setDraft(key, 'quantity', event.target.value)}
                  onFocus={(event) => event.target.select()}
                  onBlur={() => commitNumericField(index, key, 'quantity')}
                />
                <input
                  type="text"
                  inputMode="decimal"
                  className="task-materials-price"
                  value={displayNumericValue(line, 'unitPrice', key, drafts)}
                  placeholder="Unit price"
                  disabled={disabled}
                  onChange={(event) => setDraft(key, 'unitPrice', event.target.value)}
                  onFocus={(event) => event.target.select()}
                  onBlur={() => commitNumericField(index, key, 'unitPrice')}
                />
                <span className="task-materials-total">{lineTotal.toFixed(2)}</span>
                {!disabled && (
                  <button
                    type="button"
                    className="task-materials-remove"
                    aria-label="Remove material"
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
    </div>
  );
}
