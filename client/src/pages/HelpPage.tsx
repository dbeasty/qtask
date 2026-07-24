import { GITHUB_REPO_URL, SITE_URL } from '../constants/brand';

const USER_GUIDE_URL = `${GITHUB_REPO_URL}/blob/main/docs/USER_GUIDE.md`;

interface HelpPageProps {
  onBack?: () => void;
  onStartTour?: () => void;
}

export function HelpPage({ onBack, onStartTour }: HelpPageProps) {
  return (
    <div className="help-page">
      <div className="help-page-inner">
        <div className="page-header">
          <h2>Help</h2>
          <div className="page-header-actions">
            {onStartTour ? (
              <button type="button" className="primary-button" onClick={onStartTour}>
                Take a guided tour
              </button>
            ) : null}
            {onBack ? (
              <button type="button" className="secondary-button" onClick={onBack}>
                Back
              </button>
            ) : null}
          </div>
        </div>

        <p className="muted help-intro">
          Quick guide to Projects, Tasks, Agent, and sharing. For the full write-up, see the{' '}
          <a href={USER_GUIDE_URL} target="_blank" rel="noopener noreferrer">
            user guide on GitHub
          </a>
          .
        </p>

        <section className="help-section">
          <h3>Your first 10 minutes</h3>
          <ol className="help-steps-list">
            <li>Create a project on the Projects view (+ Add project).</li>
            <li>Select it in the tree to set your active project.</li>
            <li>Add a task (+ Add task) and a subtask (+ Add subtask).</li>
            <li>
              Open Agent, send a prompt, and approve the proposal when it appears.
            </li>
            <li>Press ⌘K (Ctrl+K) to search across your work.</li>
          </ol>
        </section>

        <section className="help-section">
          <h3>How QTask is organized</h3>
          <p>
            <strong>Projects</strong> are nested workspaces. <strong>Tasks</strong> are work items
            linked to one or more projects. <strong>Subtasks</strong> break a task down in the tree.{' '}
            <strong>Steps</strong> are checklist lines on a task — not the same as subtasks.
          </p>
        </section>

        <section className="help-section">
          <h3>Projects</h3>
          <p>
            Create a root project with <strong>+ Add project</strong> or a child with{' '}
            <strong>+ Add sub project</strong>. Use <strong>Move</strong> or drag to reparent
            (cycles are blocked). Deleting reparents sub-projects; tasks only in that project are
            removed, while shared tasks stay and are unlinked.
          </p>
          <p>
            Leaf project progress averages linked tasks. Parent progress rolls up from sub-projects;
            set each sub-project’s <strong>progress share</strong> to weight the rollup. Members and
            roles are per project — nesting does not inherit access.
          </p>
        </section>

        <section className="help-section">
          <h3>Active project</h3>
          <p>
            The <strong>Current project</strong> label shows what is active. Select a project in the
            tree to switch. On Tasks, click <strong>Project · …</strong> to open Projects. Agent and
            Tasks are scoped to the active project.
          </p>
        </section>

        <section className="help-section">
          <h3>Tasks and subtasks</h3>
          <p>
            Use <strong>+ Add task</strong> and <strong>+ Add subtask</strong>. Drag to reorder, or
            use the Move menu to promote subtasks or attach tasks. A task can belong to multiple
            projects — use the Projects dialog to move, link, unlink, or duplicate.
          </p>
        </section>

        <section className="help-section">
          <h3>Checklist steps</h3>
          <p>
            Steps are checkbox lines in the task detail panel. Use steps for simple to-do lines; use
            subtasks when you need status, progress, or further nesting.
          </p>
        </section>

        <section className="help-section">
          <h3>Agent</h3>
          <p>
            Ask the agent to find or change work in natural language. Use <strong>New session</strong>{' '}
            for fresh threads. Write actions show as proposals you approve or reject (unless
            auto-approve is on). Nesting projects is done in the Projects UI; the agent creates
            top-level projects and manages tasks.
          </p>
        </section>

        <section className="help-section">
          <h3>Search</h3>
          <p>
            Type in the header search box or press <strong>⌘K</strong> / <strong>Ctrl+K</strong> to
            find tasks, projects, and checklist steps.
          </p>
        </section>

        <section className="help-section">
          <h3>Preferences</h3>
          <p>
            In your account menu: <strong>Auto-approve agent actions</strong>,{' '}
            <strong>Skip delete confirmations</strong>, and <strong>Track expenses</strong> (shows
            hours and cost fields).
          </p>
        </section>

        <section className="help-section">
          <h3>Sharing and roles</h3>
          <p>
            Each project has an owner and optional collaborators:{' '}
            <strong>owner</strong> (full control including members), <strong>editor</strong>,{' '}
            <strong>executor</strong> (status/progress updates), and <strong>viewer</strong>{' '}
            (read-only). Access is always checked on the project you are using.
          </p>
        </section>

        <section className="help-section">
          <h3>More</h3>
          <p>
            Official site:{' '}
            <a href={SITE_URL} rel="noopener noreferrer">
              {SITE_URL}
            </a>
            . Full guide:{' '}
            <a href={USER_GUIDE_URL} target="_blank" rel="noopener noreferrer">
              USER_GUIDE.md
            </a>
            . Source:{' '}
            <a href={GITHUB_REPO_URL} rel="noopener noreferrer">
              GitHub
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
