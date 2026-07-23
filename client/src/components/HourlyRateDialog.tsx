import { useState } from 'react';
import { createPortal } from 'react-dom';

interface HourlyRateDialogProps {
  effectiveRate: number;
  userRate?: number;
  projectRate?: number;
  taskRate?: number;
  canEditProject: boolean;
  saving?: boolean;
  onClose: () => void;
  onSaveUserRate: (rate: number | null) => Promise<void>;
  onSaveProjectRate: (rate: number | null) => Promise<void>;
  onSaveTaskRate: (rate: number | null) => Promise<void>;
}

function formatRateInput(value?: number): string {
  return value !== undefined && value > 0 ? String(value) : '';
}

function parseRateInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function HourlyRateDialog({
  effectiveRate,
  userRate,
  projectRate,
  taskRate,
  canEditProject,
  saving = false,
  onClose,
  onSaveUserRate,
  onSaveProjectRate,
  onSaveTaskRate,
}: HourlyRateDialogProps) {
  const [userInput, setUserInput] = useState(formatRateInput(userRate));
  const [projectInput, setProjectInput] = useState(formatRateInput(projectRate));
  const [taskInput, setTaskInput] = useState(formatRateInput(taskRate));
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    try {
      await onSaveUserRate(parseRateInput(userInput));
      if (canEditProject) {
        await onSaveProjectRate(parseRateInput(projectInput));
      }
      await onSaveTaskRate(parseRateInput(taskInput));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  return createPortal(
    <div className="auth-dialog-backdrop" role="presentation" onClick={saving ? undefined : onClose}>
      <div
        className="auth-dialog hourly-rate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hourly-rate-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="hourly-rate-dialog-title">Hourly rate</h2>
        <p className="hourly-rate-effective">
          Using <strong>${effectiveRate.toFixed(2)}/hr</strong> (task → project → user)
        </p>

        <label className="task-form-field">
          <span>Your default rate</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={userInput}
            disabled={saving}
            placeholder="optional"
            onChange={(event) => setUserInput(event.target.value)}
          />
        </label>

        <label className="task-form-field">
          <span>Project rate</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={projectInput}
            disabled={saving || !canEditProject}
            placeholder="optional"
            onChange={(event) => setProjectInput(event.target.value)}
          />
        </label>

        <label className="task-form-field">
          <span>Task override</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={taskInput}
            disabled={saving}
            placeholder="optional"
            onChange={(event) => setTaskInput(event.target.value)}
          />
        </label>

        {error && <p className="error-banner">{error}</p>}

        <div className="auth-dialog-actions">
          <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={saving} onClick={() => void handleSave()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
