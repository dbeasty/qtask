import { GITHUB_REPO_URL, SITE_URL } from '../constants/brand';

interface HelpPageProps {
  onBack?: () => void;
}

export function HelpPage({ onBack }: HelpPageProps) {
  return (
    <div className="help-page">
      <div className="help-page-inner">
        <div className="page-header">
          <h2>Help</h2>
          {onBack ? (
            <div className="page-header-actions">
              <button type="button" className="secondary-button" onClick={onBack}>
                Back
              </button>
            </div>
          ) : null}
        </div>

        <p className="muted help-intro">
          Quick guide to Projects, Tasks, Agent, and sharing. For the full write-up, see the user guide
          in the repository.
        </p>

        <section className="help-section">
          <h3>Getting started</h3>
          <p>
            Use the header views to switch between <strong>Projects</strong>, <strong>Tasks</strong>,
            and <strong>Agent</strong>. Open your account menu for preferences, password, legal pages,
            and this Help screen.
          </p>
        </section>

        <section className="help-section">
          <h3>Projects</h3>
          <p>
            Projects group related work and can nest under other projects. Create a root project or a
            sub-project under an existing one. Use <strong>Move</strong> to reparent (cycles are blocked).
            Deleting a project reparents its sub-projects; tasks only in that project are removed, while
            tasks also linked elsewhere stay and are unlinked from the deleted project.
          </p>
          <p>
            Leaf project progress averages linked tasks. Parent progress rolls up from sub-projects;
            set each sub-project’s <strong>progress share</strong> to weight the rollup. Members and roles
            are per project — nesting does not inherit access.
          </p>
        </section>

        <section className="help-section">
          <h3>Active project</h3>
          <p>
            On the Tasks view, click <strong>Project · …</strong> to open the Projects view. On
            Projects, the <strong>Current project</strong> label shows what is active — select a
            project in the tree to switch. Rename, members, and delete are in the project details
            panel. Agent and Tasks are scoped to the active project.
          </p>
        </section>

        <section className="help-section">
          <h3>Tasks</h3>
          <p>
            Tasks support nested subtasks, status, priority, due dates, and percent complete. A task
            can belong to one or more projects — move, link, unlink, or duplicate across projects from
            the Tasks view.
          </p>
        </section>

        <section className="help-section">
          <h3>Agent</h3>
          <p>
            Ask the agent to find or change work in natural language. Use <strong>New session</strong> in
            the sidebar to start fresh threads. Write actions show as proposals you approve or reject
            (unless auto-approve is on). Nesting projects is done in the Projects UI; the agent creates
            top-level projects and manages tasks.
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
            . Source and contributions:{' '}
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
