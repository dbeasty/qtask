import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { TaskStep } from '../types';
import { StepMoveMenu } from './StepMoveMenu';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export function debugSteps(label: string, data?: unknown) {
  const isDev =
    typeof import.meta !== 'undefined' &&
    typeof import.meta.env !== 'undefined' &&
    Boolean(import.meta.env.DEV);
  if (isDev && localStorage.getItem('qtask:debug-steps') === '1') {
    console.log(`[task-steps] ${label}`, data ?? '');
  }
}

function isPersistedId(id?: string): boolean {
  return Boolean(id && OBJECT_ID_RE.test(id));
}

function ensureClientKey(step: TaskStep): TaskStep {
  if (step.clientKey) return step;
  return {
    ...step,
    clientKey:
      step._id && isPersistedId(step._id) ? `server-${step._id}` : `ck-${crypto.randomUUID()}`,
  };
}

export function newDraftStep(): TaskStep {
  const clientKey = `ck-${crypto.randomUUID()}`;
  return {
    _id: `draft-${crypto.randomUUID()}`,
    clientKey,
    text: '',
    done: false,
  };
}

interface TaskStepsEditorProps {
  steps: TaskStep[];
  onChange: (updater: (steps: TaskStep[]) => TaskStep[]) => void;
  /** Flush pending step edits (e.g. on blur or Enter). */
  onStepCommit?: () => void;
  disabled?: boolean;
}

function swapSteps(steps: TaskStep[], indexA: number, indexB: number): TaskStep[] {
  const next = [...steps];
  [next[indexA], next[indexB]] = [next[indexB], next[indexA]];
  return next;
}

function stepRowKey(step: TaskStep, index: number): string {
  return step.clientKey ?? step._id ?? `step-${index}`;
}

export function TaskStepsEditor({ steps, onChange, onStepCommit, disabled = false }: TaskStepsEditorProps) {
  const [focusClientKey, setFocusClientKey] = useState<string | null>(null);
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null);
  const textInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const moveTriggerRef = useRef<HTMLButtonElement | null>(null);

  const updateSteps = (updater: (current: TaskStep[]) => TaskStep[]) => {
    onChange(updater);
  };

  const updateStep = (index: number, patch: Partial<TaskStep>) => {
    updateSteps((current) =>
      current.map((step, i) => (i === index ? { ...step, ...patch } : step))
    );
  };

  const removeStep = (index: number) => {
    updateSteps((current) => current.filter((_, i) => i !== index));
  };

  const moveStepUp = (index: number) => {
    if (index <= 0) return;
    updateSteps((current) => swapSteps(current, index, index - 1));
  };

  const moveStepDown = (index: number) => {
    if (index >= steps.length - 1) return;
    updateSteps((current) => swapSteps(current, index, index + 1));
  };

  const duplicateStep = (index: number) => {
    const copy = newDraftStep();
    updateSteps((current) => {
      const source = current[index];
      if (!source) return current;
      return [
        ...current.slice(0, index + 1),
        { ...copy, text: source.text, done: source.done },
        ...current.slice(index + 1),
      ];
    });
    setFocusClientKey(copy.clientKey!);
    debugSteps('duplicate step', { index, clientKey: copy.clientKey });
  };

  const addStep = () => {
    const step = newDraftStep();
    updateSteps((current) => [...current, step]);
    setFocusClientKey(step.clientKey!);
    debugSteps('add step', { clientKey: step.clientKey });
  };

  const insertStepAfter = (index: number) => {
    const step = newDraftStep();
    updateSteps((current) => [
      ...current.slice(0, index + 1),
      step,
      ...current.slice(index + 1),
    ]);
    setFocusClientKey(step.clientKey!);
    debugSteps('insert step after Enter', { index, clientKey: step.clientKey });
  };

  useEffect(() => {
    if (!focusClientKey) return;
    const input = textInputRefs.current.get(focusClientKey);
    if (input) {
      input.focus();
      setFocusClientKey(null);
    }
  }, [focusClientKey]);

  const handleTextKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onStepCommit?.();
      insertStepAfter(index);
    }
  };

  return (
    <div className="task-form-field task-steps-editor">
      <span>Steps</span>
      <ul className="task-steps-list">
        {steps.map((step, index) => {
          const rowKey = stepRowKey(step, index);
          const menuOpen = openMenuIndex === index;
          return (
            <li key={rowKey} className="task-step-row">
              <div className="task-step-main">
                <input
                  type="checkbox"
                  className="task-step-checkbox"
                  checked={step.done}
                  onChange={(event) => updateStep(index, { done: event.target.checked })}
                  disabled={disabled}
                  aria-label={`Mark step ${index + 1} done`}
                />
                <input
                  ref={(element) => {
                    if (element) {
                      textInputRefs.current.set(rowKey, element);
                    } else {
                      textInputRefs.current.delete(rowKey);
                    }
                  }}
                  type="text"
                  className="task-step-text"
                  value={step.text}
                  onChange={(event) => updateStep(index, { text: event.target.value })}
                  onBlur={() => onStepCommit?.()}
                  onKeyDown={(event) => handleTextKeyDown(event, index)}
                  disabled={disabled}
                  placeholder="Step description"
                />
              </div>
              <div className="task-tree-move-wrap">
                <button
                  type="button"
                  className="task-tree-move-trigger"
                  ref={menuOpen ? moveTriggerRef : undefined}
                  aria-label={`Step ${index + 1} actions`}
                  aria-expanded={menuOpen}
                  disabled={disabled}
                  onClick={() => setOpenMenuIndex(menuOpen ? null : index)}
                >
                  ⋮
                </button>
                {menuOpen && (
                  <StepMoveMenu
                    anchorRef={moveTriggerRef}
                    disabled={disabled}
                    canMoveUp={index > 0}
                    canMoveDown={index < steps.length - 1}
                    onMoveUp={() => moveStepUp(index)}
                    onMoveDown={() => moveStepDown(index)}
                    onDuplicate={() => duplicateStep(index)}
                    onDelete={() => removeStep(index)}
                    onClose={() => setOpenMenuIndex(null)}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <button type="button" className="secondary-button task-steps-add" onClick={addStep} disabled={disabled}>
        Add step
      </button>
    </div>
  );
}

export function stepsForApi(steps: TaskStep[]) {
  return steps
    .map((step) => ({
      ...(step._id && OBJECT_ID_RE.test(step._id) ? { _id: step._id } : {}),
      text: step.text.trim(),
      done: step.done,
    }))
    .filter((step) => step.text.length > 0);
}

export function stepsFromTask(steps: TaskStep[] | undefined): TaskStep[] {
  return (steps ?? []).map((step) =>
    ensureClientKey({
      _id: step._id,
      text: step.text,
      done: step.done,
    })
  );
}

export function mergeLocalSteps(saved: TaskStep[], local: TaskStep[]): TaskStep[] {
  const usedSavedIds = new Set<string>();

  const merged = local.map((step) => {
    const withKey = ensureClientKey(step);

    if (isPersistedId(withKey._id)) {
      const savedStep = saved.find((item) => item._id === withKey._id);
      if (savedStep) {
        usedSavedIds.add(savedStep._id!);
        return ensureClientKey({
          ...withKey,
          _id: savedStep._id,
          text: withKey.text,
          done: withKey.done,
        });
      }
      return withKey;
    }

    if (withKey.text.trim() === '') {
      return withKey;
    }

    const match = saved.find(
      (item) =>
        item._id &&
        !usedSavedIds.has(item._id) &&
        item.text === withKey.text &&
        item.done === withKey.done
    );
    if (match?._id) {
      usedSavedIds.add(match._id);
      return ensureClientKey({ ...withKey, _id: match._id });
    }

    return withKey;
  });

  const unmatched = saved.filter((item) => item._id && !usedSavedIds.has(item._id));
  const result =
    unmatched.length > 0
      ? [...merged, ...unmatched.map((item) => ensureClientKey(item))]
      : merged;

  debugSteps('mergeLocalSteps', {
    savedCount: saved.length,
    localCount: local.length,
    outputCount: result.length,
    unmatchedCount: unmatched.length,
  });

  return result;
}

/** @deprecated Use mergeLocalSteps */
export function mergeDraftSteps(saved: TaskStep[], local: TaskStep[]): TaskStep[] {
  return mergeLocalSteps(saved, local);
}

export function stepsEqualForSave(a: TaskStep[], b: TaskStep[]): boolean {
  const apiA = stepsForApi(a);
  const apiB = stepsForApi(b);
  if (apiA.length !== apiB.length) return false;
  return apiA.every(
    (step, index) =>
      step._id === apiB[index]._id &&
      step.text === apiB[index].text &&
      step.done === apiB[index].done
  );
}

export function stepsSyncedEqual(a: TaskStep[], b: TaskStep[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((step, index) => {
    const other = b[index]!;
    return (
      stepRowKey(step, index) === stepRowKey(other, index) &&
      step.text === other.text &&
      step.done === other.done &&
      step._id === other._id
    );
  });
}
