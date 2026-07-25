import { useState } from 'react';
import { AutoResizeTextarea } from './AutoResizeTextarea';
import { shouldExpandDescriptionOnLoad } from '../utils/trackingExpand';

interface DescriptionSectionProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function DescriptionSection({ value, onChange, disabled = false }: DescriptionSectionProps) {
  const [open, setOpen] = useState(() => shouldExpandDescriptionOnLoad(value));

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
        Description
      </summary>
      <div className="task-form-tracking-body">
        <label className="task-form-field">
          <AutoResizeTextarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
          />
        </label>
      </div>
    </details>
  );
}
