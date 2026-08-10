import { useEffect, useRef, useState } from 'react';
import { getFeedbackStatus, submitFeedback } from '../api/client';

type FeedbackCategory = 'bug' | 'feature' | 'other';

interface FeedbackFormProps {
  contextUrl?: string;
  compact?: boolean;
  imagesEnabled?: boolean;
  onSuccess?: () => void;
  onRejected?: (message: string) => void;
  disabled?: boolean;
}

const REJECTION_MESSAGE =
  'Your feedback screenshot was not accepted. Please send a UI screenshot (not a photo or unrelated image).';

export function FeedbackForm({
  contextUrl,
  compact = false,
  imagesEnabled = true,
  onSuccess,
  onRejected,
  disabled = false,
}: FeedbackFormProps) {
  const [message, setMessage] = useState('');
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  function addFiles(nextFiles: File[]) {
    const images = nextFiles.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) {
      setError('Please choose a PNG, JPEG, or WebP screenshot.');
      return;
    }
    setError(null);
    setSuccess(null);
    setFiles((current) => [...current, ...images].slice(0, 3));
  }

  function handlePaste(event: ClipboardEvent) {
    if (!imagesEnabled) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const pasted: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) pasted.push(file);
      }
    }
    if (pasted.length > 0) {
      event.preventDefault();
      addFiles(pasted);
    }
  }

  useEffect(() => {
    if (!imagesEnabled) return;
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  });

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
  }

  function pollValidationStatus(feedbackId: string) {
    const startedAt = Date.now();
    const poll = async () => {
      if (Date.now() - startedAt > 30_000) return;
      try {
        const status = await getFeedbackStatus(feedbackId);
        if (status.validationStatus === 'rejected') {
          onRejected?.(REJECTION_MESSAGE);
          return;
        }
        if (status.adminReply?.message) {
          setSuccess(`Thanks — your feedback was submitted. Update: ${status.adminReply.message}`);
          return;
        }
        if (status.validationStatus === 'pending') {
          window.setTimeout(() => void poll(), 2000);
        }
      } catch {
        // ignore polling errors
      }
    };
    void poll();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled) return;
    setError(null);
    setSuccess(null);

    if (!message.trim()) {
      setError('Please describe the issue or suggestion.');
      return;
    }
    if (imagesEnabled && files.length === 0) {
      setError('Please attach at least one screenshot.');
      return;
    }

    const formData = new FormData();
    formData.set('message', message.trim());
    formData.set('category', category);
    formData.set('url', contextUrl ?? window.location.href);
    formData.set('userAgent', navigator.userAgent);
    for (const file of files) {
      formData.append('attachments', file, file.name || 'screenshot.png');
    }

    setSubmitting(true);
    try {
      const result = await submitFeedback(formData);
      setMessage('');
      setCategory('bug');
      setFiles([]);
      if (imagesEnabled && result.validationStatus === 'pending') {
        pollValidationStatus(result.id);
      }
      if (onSuccess) {
        onSuccess();
      } else {
        setSuccess('Thanks — your feedback was submitted.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit feedback');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="feedback-form" onSubmit={(event) => void handleSubmit(event)}>
      {!compact ? (
        <p className="muted feedback-form-intro">
          {imagesEnabled
            ? 'Send bug reports and suggestions with a screenshot. You can paste a screenshot from your clipboard or choose a file.'
            : 'Send bug reports and suggestions.'}
        </p>
      ) : null}

      {error ? <p className="error-banner">{error}</p> : null}
      {success ? <p className="success-banner">{success}</p> : null}
      {disabled ? (
        <p className="warning-banner">Feedback is unavailable while a major update is in progress.</p>
      ) : null}

      <label className="field-label" htmlFor="feedback-category">
        Category
      </label>
      <select
        id="feedback-category"
        value={category}
        onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
        disabled={submitting || disabled}
      >
        <option value="bug">Bug</option>
        <option value="feature">Feature request</option>
        <option value="other">Other</option>
      </select>

      <label className="field-label" htmlFor="feedback-message">
        Message
      </label>
      <textarea
        id="feedback-message"
        rows={5}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="What happened? What did you expect?"
        disabled={submitting || disabled}
      />

      {imagesEnabled ? (
        <div className="feedback-form-files">
          <label className="field-label" htmlFor="feedback-screenshot">
            Screenshot
          </label>
          <input
            ref={fileInputRef}
            id="feedback-screenshot"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            disabled={submitting || disabled}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          {files.length > 0 ? (
            <ul className="feedback-preview-list">
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`}>
                  <img src={previews[index]} alt={file.name || `Screenshot ${index + 1}`} />
                  <div className="feedback-preview-meta">
                    <span>{file.name || `Screenshot ${index + 1}`}</span>
                    <button type="button" className="secondary-button" onClick={() => removeFile(index)}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No screenshot selected yet.</p>
          )}
        </div>
      ) : null}

      <div className="feedback-form-actions">
        <button type="submit" className="primary-button" disabled={submitting || disabled}>
          {submitting ? 'Submitting…' : 'Send feedback'}
        </button>
      </div>
    </form>
  );
}
