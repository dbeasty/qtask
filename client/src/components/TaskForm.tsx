import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Project, TaskPriority, TaskStatus } from '../types';
import { ProjectComboBox } from './ProjectComboBox';
import { TaskProgressSlider } from './TaskProgressSlider';
import { TaskSplitInput } from './TaskSplitInput';

export interface TaskFormValues {
  title: string;
  description: string;
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

interface TaskFormBaseProps {
  mode: 'create' | 'edit';
  initialValues: TaskFormValues;
  showProjectFields?: boolean;
  showProgressFields?: boolean;
  showProgressShare?: boolean;
  projects?: Project[];
  saving?: boolean;
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
    onSave: (values: TaskFormValues) => Promise<void>;
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
    className,
    readOnlyProgress = false,
    progressValue,
    autoSave,
  } = props;

  const [values, setValues] = useState<TaskFormValues>(initialValues);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const lastSavedRef = useRef<TaskFormValues>(initialValues);
  const saveGenerationRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    saveGenerationRef.current += 1;

    if (!isDirtyRef.current) {
      setValues(initialValues);
      lastSavedRef.current = initialValues;
    }

    setValidationError(null);
    setSaveStatus('idle');
    setSaveError(null);
  }, [initialValues, clearDebounce]);

  useEffect(() => {
    return () => {
      clearDebounce();
      clearSavedFade();
    };
  }, [clearDebounce, clearSavedFade]);

  const performAutoSave = useCallback(
    async (nextValues: TaskFormValues) => {
      if (!autoSave) return;

      if (!nextValues.title.trim()) {
        setValidationError('Title is required');
        setSaveStatus('error');
        setSaveError('Title is required');
        return;
      }

      if (valuesEqual(nextValues, lastSavedRef.current)) {
        return;
      }

      const generation = saveGenerationRef.current;
      setValidationError(null);
      setSaveError(null);
      setSaveStatus('saving');

      try {
        const normalized = { ...nextValues, title: nextValues.title.trim() };
        await autoSave.onSave(normalized);

        if (generation !== saveGenerationRef.current) return;

        lastSavedRef.current = normalized;
        isDirtyRef.current = false;
        setSaveStatus('saved');
        clearSavedFade();
        savedFadeTimerRef.current = setTimeout(() => {
          setSaveStatus('idle');
        }, 2000);
      } catch (err) {
        if (generation !== saveGenerationRef.current) return;

        const message = err instanceof Error ? err.message : 'Save failed';
        setSaveStatus('error');
        setSaveError(message);
      }
    },
    [autoSave, clearSavedFade]
  );

  const scheduleAutoSave = useCallback(
    (nextValues: TaskFormValues) => {
      if (!autoSave) return;

      clearDebounce();
      debounceTimerRef.current = setTimeout(() => {
        void performAutoSave(nextValues);
      }, autoSave.debounceMs ?? 500);
    },
    [autoSave, clearDebounce, performAutoSave]
  );

  const updateValues = useCallback(
    (updater: (current: TaskFormValues) => TaskFormValues) => {
      setValues((current) => {
        const next = updater(current);
        isDirtyRef.current = !valuesEqual(next, lastSavedRef.current);
        if (autoSave) {
          scheduleAutoSave(next);
        }
        return next;
      });
    },
    [autoSave, scheduleAutoSave]
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

      <label className="task-form-field task-form-field-title">
        <span>Title</span>
        <input
          type="text"
          value={values.title}
          onChange={(event) => updateValues((current) => ({ ...current, title: event.target.value }))}
          disabled={saving}
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
          disabled={saving}
          rows={3}
        />
      </label>

      <div className="task-form-row">
        <label className="task-form-field">
          <span>Status</span>
          <select
            value={values.status}
            onChange={(event) => handleStatusChange(event.target.value as TaskStatus)}
            disabled={saving}
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
            disabled={saving}
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
        <div className="task-form-progress-section">
          <div className="task-form-field">
            <span>Progress</span>
            <TaskProgressSlider
              value={values.percentComplete}
              disabled={saving}
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
                disabled={saving}
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
                disabled={saving}
                placeholder="optional"
              />
            </label>
          </div>
        </div>
      )}

      {showProgressShare && (
        <div className="task-form-field">
          <span>Task split</span>
          <TaskSplitInput
            value={values.progressShare}
            onChange={(progressShare) => updateValues((current) => ({ ...current, progressShare }))}
            disabled={saving}
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
              disabled={saving}
            />
          </label>

          <label className="task-form-field">
            <span>Tags</span>
            <input
              type="text"
              value={values.tags}
              onChange={(event) => updateValues((current) => ({ ...current, tags: event.target.value }))}
              disabled={saving}
              placeholder="comma-separated"
            />
          </label>
        </>
      )}

      {!autoSave && (
        <div className="task-form-actions">
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Saving…' : (props as TaskFormSubmitProps).submitLabel}
          </button>
          {(props as TaskFormSubmitProps).onCancel && (
            <button
              type="button"
              className="secondary-button"
              onClick={(props as TaskFormSubmitProps).onCancel}
              disabled={saving}
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
