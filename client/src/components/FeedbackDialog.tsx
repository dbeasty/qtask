import { useId } from 'react';
import { createPortal } from 'react-dom';
import { FeedbackForm } from './FeedbackForm';

interface FeedbackDialogProps {
  onClose: () => void;
  contextUrl?: string;
  imagesEnabled?: boolean;
  disabled?: boolean;
}

export function FeedbackDialog({
  onClose,
  contextUrl,
  imagesEnabled = true,
  disabled = false,
}: FeedbackDialogProps) {
  const formKey = useId();

  return createPortal(
    <div className="auth-dialog-backdrop feedback-dialog-backdrop" onClick={onClose}>
      <div
        className="auth-dialog feedback-dialog"
        role="dialog"
        aria-labelledby="feedback-dialog-title"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="feedback-dialog-title">Send feedback</h2>
        <FeedbackForm
          key={formKey}
          contextUrl={contextUrl}
          compact
          imagesEnabled={imagesEnabled}
          disabled={disabled}
          onSuccess={onClose}
        />
      </div>
    </div>,
    document.body
  );
}
