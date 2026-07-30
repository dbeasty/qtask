import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

interface PasswordInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
  placeholder?: string;
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M1 1l22 22" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    </svg>
  );
}

export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  minLength,
  required,
  placeholder,
}: PasswordInputProps) {
  const [show, setShow] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function syncFromDom() {
    const domValue = inputRef.current?.value ?? '';
    if (domValue !== value) {
      onChange(domValue);
    }
  }

  function handleToggle() {
    syncFromDom();
    setShow((current) => !current);
  }

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const onAnimation = (event: AnimationEvent) => {
      if (event.animationName === 'qtask-autofill-start') {
        onChange(input.value);
      }
    };

    input.addEventListener('animationstart', onAnimation);
    return () => input.removeEventListener('animationstart', onAnimation);
  }, [onChange]);

  useEffect(() => {
    const input = inputRef.current;
    const form = input?.form;
    if (!input || !form) return;

    const syncBeforeSubmit = () => {
      const domValue = input.value;
      if (domValue !== value) {
        flushSync(() => onChange(domValue));
      }
    };

    form.addEventListener('submit', syncBeforeSubmit, true);
    return () => form.removeEventListener('submit', syncBeforeSubmit, true);
  }, [onChange, value]);

  return (
    <div className="password-field">
      <input
        ref={inputRef}
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onInput={(e) => onChange(e.currentTarget.value)}
        autoComplete={autoComplete}
        minLength={minLength}
        required={required}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={handleToggle}
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
      >
        {show ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}
