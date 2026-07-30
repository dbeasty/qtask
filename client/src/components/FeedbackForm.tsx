import { useEffect, useRef, useState } from 'react';
import { submitFeedback } from '../api/client';

type FeedbackCategory = 'bug' | 'feature' | 'other';

interface FeedbackFormProps {
  contextUrl?: string;
  compact?: boolean;
  onSuccess?: () => void;
}

export function FeedbackForm({ contextUrl, compact = false, onSuccess }: FeedbackFormProps) {
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
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  });

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (!message.trim()) {
      setError('Please describe the issue or suggestion.');
      return;
    }
    if (files.length === 0) {
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
      await submitFeedback(formData);
      setMessage('');
      setCategory('bug');
      setFiles([]);
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
          Send bug reports and suggestions with a screenshot. You can paste a screenshot from your
          clipboard or choose a file.
        </p>
      ) : null}

      {error ? <p className="error-banner">{error}</p> : null}
      {success ? <p className="success-banner">{success}</p> : null}

      <label className="field-label" htmlFor="feedback-category">
        Category
      </label>
      <select
        id="feedback-category"
        value={category}
        onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
        disabled={submitting}
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
        disabled={submitting}
      />

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
          disabled={submitting}
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

      <div className="feedback-form-actions">
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Send feedback'}
        </button>
      </div>
    </form>
  );
}
