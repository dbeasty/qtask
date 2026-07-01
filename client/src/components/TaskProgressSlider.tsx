import { useEffect, useRef, useState } from 'react';

interface TaskProgressSliderProps {
  value: number;
  disabled?: boolean;
  saving?: boolean;
  onChange?: (percent: number) => void;
}

export function TaskProgressSlider({
  value,
  disabled = false,
  saving = false,
  onChange,
}: TaskProgressSliderProps) {
  const [localValue, setLocalValue] = useState(value);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const commit = (next: number) => {
    if (disabled || saving || !onChange) return;
    onChange(next);
  };

  const handleChange = (next: number) => {
    setLocalValue(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commit(next), 300);
  };

  const handlePointerUp = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    commit(localValue);
  };

  return (
    <div className={`task-progress-slider${disabled ? ' disabled' : ''}${saving ? ' saving' : ''}`}>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={localValue}
        disabled={disabled || saving}
        onChange={(event) => handleChange(Number(event.target.value))}
        onMouseUp={handlePointerUp}
        onTouchEnd={handlePointerUp}
        onClick={(event) => event.stopPropagation()}
        aria-label="Progress"
      />
      <span className="task-progress-label">{localValue}%</span>
    </div>
  );
}
