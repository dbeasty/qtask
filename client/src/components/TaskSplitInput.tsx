import { useMemo } from 'react';
import { TaskProgressSlider } from './TaskProgressSlider';

export const SPLIT_PRESETS = [
  { label: 'Equal split (auto)', value: '' },
  { label: 'Minor — 10%', value: '10' },
  { label: 'Quarter — 25%', value: '25' },
  { label: 'Third — 33%', value: '33' },
  { label: 'Half — 50%', value: '50' },
  { label: 'Major — 75%', value: '75' },
  { label: 'Full — 100%', value: '100' },
] as const;

function presetForValue(value: string) {
  return SPLIT_PRESETS.find((preset) => preset.value === value);
}

function parseSplitInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const preset = SPLIT_PRESETS.find((item) => item.label.toLowerCase() === trimmed.toLowerCase());
  if (preset) return preset.value;

  const numeric = Number(trimmed.replace(/%/g, ''));
  if (!Number.isFinite(numeric)) return trimmed;

  return String(Math.max(0, Math.min(100, Math.round(numeric))));
}

interface TaskSplitInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function TaskSplitInput({ value, onChange, disabled = false }: TaskSplitInputProps) {
  const listId = 'task-split-presets';
  const preset = presetForValue(value);
  const displayValue = preset ? preset.label : value;
  const numericValue = value.trim() === '' ? 0 : Number(value);
  const sliderValue = Number.isFinite(numericValue) ? numericValue : 0;

  const filteredPresets = useMemo(() => {
    const normalized = displayValue.trim().toLowerCase();
    if (!normalized) return SPLIT_PRESETS;
    return SPLIT_PRESETS.filter((item) => item.label.toLowerCase().includes(normalized));
  }, [displayValue]);

  const handleInputChange = (raw: string) => {
    onChange(parseSplitInput(raw));
  };

  const handleSliderChange = (percent: number) => {
    onChange(String(percent));
  };

  return (
    <div className="task-split-input">
      <div className="task-split-combobox">
        <input
          type="text"
          list={listId}
          value={displayValue}
          onChange={(event) => handleInputChange(event.target.value)}
          disabled={disabled}
          placeholder="Equal split (auto)"
          aria-label="Task split preset or percentage"
        />
        <datalist id={listId}>
          {filteredPresets.map((item) => (
            <option key={item.label} value={item.label} />
          ))}
        </datalist>
      </div>

      <div className="task-split-dial">
        <span className="task-split-dial-label">Split %</span>
        <TaskProgressSlider
          value={sliderValue}
          disabled={disabled}
          onChange={handleSliderChange}
        />
        {value.trim() === '' && <span className="task-split-auto-hint">Equal split across siblings</span>}
      </div>
    </div>
  );
}
