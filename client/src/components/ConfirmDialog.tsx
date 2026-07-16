import { useState } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  dontAskAgainLabel?: string;
  busy?: boolean;
  onConfirm: (dontAskAgain: boolean) => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  title = 'Confirm',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  dontAskAgainLabel = "Don't ask again",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);

  return createPortal(
    <div className="auth-dialog-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <div
        className="auth-dialog confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-message" className="confirm-dialog-message">
          {message}
        </p>

        <label className="confirm-dialog-checkbox">
          <input
            type="checkbox"
            checked={dontAskAgain}
            disabled={busy}
            onChange={(event) => setDontAskAgain(event.target.checked)}
          />
          <span>{dontAskAgainLabel}</span>
        </label>

        <div className="auth-dialog-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void onConfirm(dontAskAgain)}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
