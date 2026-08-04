import { GITHUB_REPO_URL, SITE_URL } from '../constants/brand';

const USER_GUIDE_URL = `${GITHUB_REPO_URL}/blob/main/docs/USER_GUIDE.md`;
const MCP_GUIDE_URL = `${GITHUB_REPO_URL}/blob/main/docs/MCP.md`;

export function WelcomePage() {
  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        <h1>QTask</h1>
        <p className="welcome-lead">
          Task management with an MCP server for Claude Desktop, Cursor, and local AI agents.
        </p>

        <section className="welcome-section">
          <h2>Connect your AI tools</h2>
          <ul className="welcome-list">
            <li>
              <strong>Claude Desktop</strong> — OAuth connector; manage tasks from Claude without leaving the chat
            </li>
            <li>
              <strong>Cursor</strong> — MCP API key + stdio bridge; keep tasks in sync with your editor workflow
            </li>
            <li>
              <strong>Self-hosted</strong> — run locally with Ollama and the built-in agent
            </li>
          </ul>
        </section>

        <section className="welcome-section">
          <h2>What QTask does</h2>
          <p>
            QTask helps you manage tasks and projects with an AI assistant at the center. Use the in-app agent to
            create, organize, and update your work — or use the task board directly. External AI clients connect via
            MCP so your tasks stay in sync wherever you work.
          </p>
        </section>

        <section className="welcome-section">
          <h2>Features</h2>
          <ul className="welcome-list">
            <li>MCP server for Claude Desktop, Cursor, and other MCP clients</li>
            <li>Nested tasks with status, priority, and progress tracking</li>
            <li>Nested projects with progress rollup</li>
            <li>AI agent with proposal approval before changes are applied</li>
            <li>Semantic search across your tasks</li>
            <li>Self-hosted — your data stays on your infrastructure</li>
            <li>Swappable AI backends (local Ollama, MCP-compatible models)</li>
          </ul>
        </section>

        <div className="welcome-actions">
          <a href="/register" className="auth-submit welcome-cta">
            Get started
          </a>
          <a href="/login" className="secondary-button welcome-cta-secondary">
            Sign in
          </a>
        </div>

        <footer className="welcome-footer muted">
          <p className="welcome-footer-site">
            Official site: <a href={SITE_URL}>{SITE_URL}</a>
          </p>
          <p className="welcome-footer-links">
            <a href={MCP_GUIDE_URL} target="_blank" rel="noopener noreferrer">
              MCP setup (Claude &amp; Cursor)
            </a>
            <span aria-hidden="true"> · </span>
            <a href={USER_GUIDE_URL} target="_blank" rel="noopener noreferrer">
              How to use QTask
            </a>
            <span aria-hidden="true"> · </span>
            <a href="/terms">Terms &amp; Disclaimer</a>
            <span aria-hidden="true"> · </span>
            <a href="/privacy">Privacy Policy</a>
            <span aria-hidden="true"> · </span>
            <a href={GITHUB_REPO_URL} rel="noopener noreferrer">
              Contribute on GitHub
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}
