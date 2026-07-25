import { useState } from 'react';
import { AutoResizeTextarea } from './AutoResizeTextarea';
import { shouldExpandNotesOnLoad } from '../utils/trackingExpand';

interface NotesSectionProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function NotesSection({ value, onChange, disabled = false }: NotesSectionProps) {
  const [open, setOpen] = useState(() => shouldExpandNotesOnLoad(value));

  return (
    <details
      className="task-form-tracking-section"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="task-form-tracking-summary">
        <span className={`project-toolbar-chevron${open ? ' expanded' : ''}`} aria-hidden="true">
          ›
        </span>
        Notes
      </summary>
      <div className="task-form-tracking-body">
        <label className="task-form-field">
          <AutoResizeTextarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            className="task-form-notes-textarea"
          />
        </label>
      </div>
    </details>
  );
}
