interface DemoTourPromptProps {
  onStart: () => void;
  onDismiss: () => void;
}

export function DemoTourPrompt({ onStart, onDismiss }: DemoTourPromptProps) {
  return (
    <div className="demo-tour-prompt-backdrop" role="presentation">
      <div
        className="demo-tour-prompt"
        role="dialog"
        aria-labelledby="demo-tour-prompt-title"
        aria-modal="true"
      >
        <h2 id="demo-tour-prompt-title">Welcome to QTask</h2>
        <p>
          Take a quick guided tour to see how projects, tasks, and the AI agent work together. You
          can restart the tour anytime from Help or your account menu.
        </p>
        <div className="demo-tour-prompt-actions">
          <button type="button" className="primary-button" onClick={onStart}>
            Take a tour
          </button>
          <button type="button" className="secondary-button" onClick={onDismiss}>
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
