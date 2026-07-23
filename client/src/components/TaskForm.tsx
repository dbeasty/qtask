import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Project, TaskPriority, TaskStatus, TaskStep } from '../types';
import { ProjectComboBox } from './ProjectComboBox';
import { TaskProgressSlider } from './TaskProgressSlider';
import { TaskSplitInput } from './TaskSplitInput';
import { mergeLocalSteps, stepsSyncedEqual, stepsEqualForSave, stepsForApi, debugSteps, TaskStepsEditor } from './TaskStepsEditor';

export interface TaskFormValues {
  title: string;
  description: string;
  steps: TaskStep[];
  status: TaskStatus;
  priority: TaskPriority;
  projectName: string;
  tags: string;
  percentComplete: number;
  progressShare: string;
  hoursSpent: string;
  hoursRemaining: string;
  lastProgressField: 'percent' | 'hoursSpent' | 'hoursRemaining';
}

const STATUS_OPTIONS: TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

function valuesEqual(a: TaskFormValues, b: TaskFormValues): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    stepsSyncedEqual(a.steps, b.steps) &&
    a.status === b.status &&
    a.priority === b.priority &&
    a.projectName === b.projectName &&
    a.tags === b.tags &&
    a.percentComplete === b.percentComplete &&
    a.progressShare === b.progressShare &&
    a.hoursSpent === b.hoursSpent &&
    a.hoursRemaining === b.hoursRemaining &&
    a.lastProgressField === b.lastProgressField
  );
}

function valuesEqualForSave(a: TaskFormValues, b: TaskFormValues): boolean {
  return (
    a.title.trim() === b.title.trim() &&
    a.description === b.description &&
    stepsEqualForSave(a.steps, b.steps) &&
    a.status === b.status &&
    a.priority === b.priority &&
    a.projectName === b.projectName &&
    a.tags === b.tags &&
    a.percentComplete === b.percentComplete &&
    a.progressShare === b.progressShare &&
    a.hoursSpent === b.hoursSpent &&
    a.hoursRemaining === b.hoursRemaining &&
    a.lastProgressField === b.lastProgressField
  );
}

function applySavedValuesToRefs(
  savedValues: TaskFormValues,
  valuesRef: { current: TaskFormValues },
  lastSavedRef: { current: TaskFormValues },
  isDirtyRef: { current: boolean }
): void {
  const mergedSteps = mergeLocalSteps(savedValues.steps, valuesRef.current.steps);
  valuesRef.current = {
    ...valuesRef.current,
    percentComplete: savedValues.percentComplete,
    hoursSpent: savedValues.hoursSpent,
    hoursRemaining: savedValues.hoursRemaining,
    progressShare: savedValues.progressShare,
    status: savedValues.status,
    steps: mergedSteps,
  };
  lastSavedRef.current = savedValues;
  isDirtyRef.current = !valuesEqualForSave(valuesRef.current, lastSavedRef.current);
}

interface TaskFormBaseProps {
  mode: 'create' | 'edit';
  initialValues: TaskFormValues;
  showProjectFields?: boolean;
  showProgressFields?: boolean;
  showProgressShare?: boolean;
  projects?: Project[];
  saving?: boolean;
  /** When true, fields are non-editable (e.g. viewer role). */
  disabled?: boolean;
  /** When true with disabled, status may still be changed (e.g. executor role). */
  statusEditable?: boolean;
  className?: string;
  readOnlyProgress?: boolean;
  progressValue?: number;
}

interface TaskFormSubmitProps extends TaskFormBaseProps {
  autoSave?: undefined;
  submitLabel: string;
  onSubmit: (values: TaskFormValues) => Promise<void>;
  onCancel?: () => void;
}

interface TaskFormAutoSaveProps extends TaskFormBaseProps {
  autoSave: {
    onSave: (values: TaskFormValues) => Promise<TaskFormValues | void>;
    debounceMs?: number;
  };
  submitLabel?: never;
  onSubmit?: never;
  onCancel?: never;
}

type TaskFormProps = TaskFormSubmitProps | TaskFormAutoSaveProps;

export function TaskForm(props: TaskFormProps) {
  const {
    mode,
    initialValues,
    showProjectFields = false,
    showProgressFields = false,
    showProgressShare = false,
    projects = [],
    saving = false,
    disabled = false,
    statusEditable = false,
    className,
    readOnlyProgress = false,
    progressValue,
    autoSave,
  } = props;

  const fieldsDisabled = saving || disabled;
  const statusDisabled = saving || (disabled && !statusEditable);
  const canAutoSave = !disabled || statusEditable;

  const [values, setValues] = useState<TaskFormValues>(initialValues);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const lastSavedRef = useRef<TaskFormValues>(initialValues);
  const valuesRef = useRef<TaskFormValues>(initialValues);
  const saveGenerationRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef(Promise.resolve());
  const isDirtyRef = useRef(false);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearSavedFade = useCallback(() => {
    if (savedFadeTimerRef.current) {
      clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearDebounce();
    if (isDirtyRef.current) {
      saveGenerationRef.current += 1;
    }

    if (!isDirtyRef.current) {
      setValues((current) => {
        const mergedSteps = mergeLocalSteps(initialValues.steps, current.steps);
        const next = {
          ...initialValues,
          steps: mergedSteps,
        };
        if (valuesEqual(current, next)) {
          debugSteps('initialValues sync skipped (no change)', {
            stepCount: current.steps.length,
          });
          return current;
        }
        debugSteps('initialValues sync applied', {
          beforeStepCount: current.steps.length,
          afterStepCount: mergedSteps.length,
        });
        valuesRef.current = next;
        lastSavedRef.current = next;
        return next;
      });
    }

    setValidationError(null);
    setSaveStatus('idle');
    setSaveError(null);
  }, [initialValues, clearDebounce]);

  const runAutoSave = useCallback(
    async (nextValues: TaskFormValues) => {
      if (!autoSave || !canAutoSave) return;

      if (!nextValues.title.trim()) {
        debugSteps('autoSave skipped', { reason: 'title missing' });
        setValidationError('Title is required');
        setSaveStatus('error');
        setSaveError('Title is required');
        return;
      }

      if (valuesEqualForSave(nextValues, lastSavedRef.current)) {
        debugSteps('autoSave skipped', { reason: 'no-op' });
        return;
      }

      const generation = saveGenerationRef.current;
      setValidationError(null);
      setSaveError(null);
      setSaveStatus('saving');

      debugSteps('autoSave started', {
        stepCount: nextValues.steps.length,
        apiStepCount: stepsForApi(nextValues.steps).length,
      });

      try {
        const normalized = { ...nextValues, title: nextValues.title.trim() };
        const savedValues = (await autoSave.onSave(normalized)) ?? normalized;

        if (generation !== saveGenerationRef.current) {
          debugSteps('autoSave aborted', { reason: 'generation stale' });
          return;
        }

        applySavedValuesToRefs(savedValues, valuesRef, lastSavedRef, isDirtyRef);

        if (!isDirtyRef.current) {
          setSaveStatus('saved');
          debugSteps('autoSave succeeded', { stepCount: savedValues.steps.length });
          clearSavedFade();
          savedFadeTimerRef.current = setTimeout(() => {
            setSaveStatus('idle');
          }, 2000);
        } else {
          setSaveStatus('idle');
        }
      } catch (err) {
        if (generation !== saveGenerationRef.current) return;

        const message = err instanceof Error ? err.message : 'Save failed';
        debugSteps('autoSave failed', { error: message });
        setSaveStatus('error');
        setSaveError(message);
      }
    },
    [autoSave, clearSavedFade, canAutoSave]
  );

  const enqueueAutoSaveRef = useRef<() => void>(() => {});
  const autoSaveRef = useRef(autoSave);
  const canAutoSaveRef = useRef(canAutoSave);
  autoSaveRef.current = autoSave;
  canAutoSaveRef.current = canAutoSave;

  const enqueueAutoSave = useCallback(() => {
    if (!autoSave || !canAutoSave) return;
    saveChainRef.current = saveChainRef.current
      .then(() => runAutoSave(valuesRef.current))
      .catch(() => {
        // runAutoSave updates error UI; keep the chain alive for later saves
      });
  }, [autoSave, canAutoSave, runAutoSave]);

  enqueueAutoSaveRef.current = enqueueAutoSave;

  const scheduleAutoSave = useCallback(
    (_nextValues: TaskFormValues) => {
      if (!autoSave || !canAutoSave) return;

      debugSteps('autoSave scheduled', {
        debounceMs: autoSave.debounceMs ?? 500,
        stepCount: valuesRef.current.steps.length,
      });

      clearDebounce();
      debounceTimerRef.current = setTimeout(() => {
        enqueueAutoSave();
      }, autoSave.debounceMs ?? 500);
    },
    [autoSave, clearDebounce, enqueueAutoSave, canAutoSave]
  );

  const flushAutoSave = useCallback(() => {
    if (!autoSave || !canAutoSave) return;
    clearDebounce();
    debugSteps('autoSave flush', { stepCount: valuesRef.current.steps.length });
    enqueueAutoSave();
  }, [autoSave, canAutoSave, clearDebounce, enqueueAutoSave]);

  useEffect(() => {
    return () => {
      clearDebounce();
      clearSavedFade();
      if (autoSaveRef.current && canAutoSaveRef.current && isDirtyRef.current) {
        debugSteps('autoSave flush on unmount', {
          stepCount: valuesRef.current.steps.length,
          apiStepCount: stepsForApi(valuesRef.current.steps).length,
        });
        enqueueAutoSaveRef.current();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flush only on true unmount
  }, []);

  const updateValues = useCallback(
    (updater: (current: TaskFormValues) => TaskFormValues) => {
      setValues((current) => {
        const next = updater(current);
        valuesRef.current = next;
        isDirtyRef.current = !valuesEqualForSave(next, lastSavedRef.current);
        if (autoSave && canAutoSave) {
          scheduleAutoSave(next);
        }
        return next;
      });
    },
    [autoSave, scheduleAutoSave, canAutoSave]
  );

  const handleStatusChange = (status: TaskStatus) => {
    updateValues((current) => ({
      ...current,
      status,
      percentComplete: status === 'done' ? 100 : current.percentComplete,
      lastProgressField: 'percent',
    }));
  };

  const handlePercentChange = (percent: number) => {
    updateValues((current) => ({
      ...current,
      percentComplete: percent,
      lastProgressField: 'percent',
    }));
  };

  const handleHoursChange = (field: 'hoursSpent' | 'hoursRemaining', raw: string) => {
    updateValues((current) => {
      const next = { ...current, [field]: raw, lastProgressField: field };
      const spent = parseFloat(field === 'hoursSpent' ? raw : current.hoursSpent) || 0;
      const remaining = parseFloat(field === 'hoursRemaining' ? raw : current.hoursRemaining) || 0;
      const total = spent + remaining;
      if (total > 0) {
        next.percentComplete = Math.round((spent / total) * 100);
      }
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (autoSave) return;

    const { onSubmit } = props as TaskFormSubmitProps;
    if (!values.title.trim()) {
      setValidationError('Title is required');
      return;
    }
    setValidationError(null);
    await onSubmit({ ...values, title: values.title.trim() });
  };

  const formClassName = ['task-form', className].filter(Boolean).join(' ');

  return (
    <form className={formClassName} onSubmit={handleSubmit}>
      {autoSave && saveStatus !== 'idle' && (
        <p
          className={`task-save-status task-save-status-${saveStatus}`}
          role="status"
          aria-live="polite"
        >
          {saveStatus === 'saving' && 'Saving…'}
          {saveStatus === 'saved' && 'Saved'}
          {saveStatus === 'error' && (saveError ?? 'Save failed')}
        </p>
      )}

      {validationError && !autoSave && <p className="error-banner">{validationError}</p>}
      {validationError && autoSave && saveStatus === 'error' && (
        <p className="error-banner">{validationError}</p>
      )}

      <label
        className={`task-form-field task-form-field-title${mode === 'edit' ? ' task-form-field-title-edit' : ''}`}
      >
        {mode === 'create' && <span>Title</span>}
        <input
          type="text"
          value={values.title}
          onChange={(event) => updateValues((current) => ({ ...current, title: event.target.value }))}
          disabled={fieldsDisabled}
          autoFocus={mode === 'create'}
        />
      </label>

      <label className="task-form-field">
        <span>Description</span>
        <textarea
          value={values.description}
          onChange={(event) =>
            updateValues((current) => ({ ...current, description: event.target.value }))
          }
          disabled={fieldsDisabled}
          rows={3}
        />
      </label>

      <TaskStepsEditor
        steps={values.steps}
        onChange={(updater) => updateValues((current) => ({ ...current, steps: updater(current.steps) }))}
        onStepCommit={autoSave ? flushAutoSave : undefined}
        disabled={fieldsDisabled}
      />

      <details className="task-form-tracking-section">
        <summary className="task-form-tracking-summary">
          <span className="project-toolbar-chevron" aria-hidden="true" />
          Tracking
        </summary>
        <div className="task-form-tracking-body">
          <div className="task-form-row">
            <label className="task-form-field">
              <span>Status</span>
              <select
                value={values.status}
                onChange={(event) => handleStatusChange(event.target.value as TaskStatus)}
                disabled={statusDisabled}
              >
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>

            <label className="task-form-field">
              <span>Priority</span>
              <select
                value={values.priority}
                onChange={(event) =>
                  updateValues((current) => ({
                    ...current,
                    priority: event.target.value as TaskPriority,
                  }))
                }
                disabled={fieldsDisabled}
              >
                {PRIORITY_OPTIONS.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {readOnlyProgress && progressValue !== undefined && (
            <div className="task-form-field">
              <span>Progress</span>
              <TaskProgressSlider value={progressValue} disabled />
            </div>
          )}

          {showProgressFields && !readOnlyProgress && (
            <>
              <div className="task-form-field">
                <span>Progress</span>
                <TaskProgressSlider
                  value={values.percentComplete}
                  disabled={fieldsDisabled}
                  onChange={handlePercentChange}
                />
              </div>

              <div className="task-form-row">
                <label className="task-form-field">
                  <span>Hours spent</span>
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={values.hoursSpent}
                    onChange={(event) => handleHoursChange('hoursSpent', event.target.value)}
                    disabled={fieldsDisabled}
                    placeholder="optional"
                  />
                </label>
                <label className="task-form-field">
                  <span>Hours remaining</span>
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={values.hoursRemaining}
                    onChange={(event) => handleHoursChange('hoursRemaining', event.target.value)}
                    disabled={fieldsDisabled}
                    placeholder="optional"
                  />
                </label>
              </div>
            </>
          )}
        </div>
      </details>

      {showProgressShare && (
        <div className="task-form-field">
          <span>Task split</span>
          <TaskSplitInput
            value={values.progressShare}
            onChange={(progressShare) => updateValues((current) => ({ ...current, progressShare }))}
            disabled={fieldsDisabled}
          />
        </div>
      )}

      {showProjectFields && (
        <>
          <label className="task-form-field">
            <span>Project</span>
            <ProjectComboBox
              value={values.projectName}
              projects={projects}
              onChange={(name) => updateValues((current) => ({ ...current, projectName: name }))}
              disabled={fieldsDisabled}
            />
          </label>

          <label className="task-form-field">
            <span>Tags</span>
            <input
              type="text"
              value={values.tags}
              onChange={(event) => updateValues((current) => ({ ...current, tags: event.target.value }))}
              disabled={fieldsDisabled}
              placeholder="comma-separated"
            />
          </label>
        </>
      )}

      {!autoSave && (
        <div className="task-form-actions">
          <button type="submit" className="primary-button" disabled={fieldsDisabled}>
            {saving ? 'Saving…' : (props as TaskFormSubmitProps).submitLabel}
          </button>
          {(props as TaskFormSubmitProps).onCancel && (
            <button
              type="button"
              className="secondary-button"
              onClick={(props as TaskFormSubmitProps).onCancel}
              disabled={fieldsDisabled}
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </form>
  );
}

export function parseTagsInput(tags: string): string[] {
  return tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function emptyFormValues(projectName = ''): TaskFormValues {
  return {
    title: '',
    description: '',
    steps: [],
    status: 'todo',
    priority: 'medium',
    projectName,
    tags: '',
    percentComplete: 0,
    progressShare: '',
    hoursSpent: '',
    hoursRemaining: '',
    lastProgressField: 'percent',
  };
}
