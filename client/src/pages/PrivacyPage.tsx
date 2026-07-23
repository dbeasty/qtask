import { useAuth } from '../auth/AuthContext';
import { GITHUB_REPO_URL, SITE_DOMAIN, SITE_URL } from '../constants/brand';

export function PrivacyPage() {
  const { user } = useAuth();

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide legal-page">
        <h1>Privacy Policy</h1>
        <p className="muted legal-version">Version 1.0</p>

        <section className="legal-section">
          <h2>Overview</h2>
          <p>
            QTask is open-source software that you self-host. This policy describes how the software
            handles data in a typical deployment. The person or organization operating a QTask instance
            (&ldquo;the operator&rdquo;) controls the server and database where your data is stored. The
            official instance at <a href={SITE_URL}>{SITE_DOMAIN}</a> is operated under these same
            principles.
          </p>
        </section>

        <section className="legal-section">
          <h2>What we collect</h2>
          <p>QTask stores the following in your MongoDB database:</p>
          <ul className="welcome-list">
            <li>Account information: email address, display name, and a hashed password</li>
            <li>Tasks, projects, and related metadata you create</li>
            <li>Agent sessions and AI interaction history</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>We do not sell your data</h2>
          <p>
            QTask does not operate a commercial data business. The software does not sell, rent, trade,
            or otherwise monetize your personal data or task content. There are no third-party ad
            networks, analytics pixels, or behavioral profiling built into the software. This applies to
            the {SITE_DOMAIN} hosted instance as well as self-hosted deployments.
          </p>
        </section>

        <section className="legal-section">
          <h2>Self-hosted responsibility</h2>
          <p>
            Whoever deploys QTask controls the server, database, backups, and network access. The
            operator is responsible for access controls, securing the deployment, and compliance with
            privacy laws that apply in their jurisdiction.
          </p>
        </section>

        <section className="legal-section">
          <h2>Security disclaimer</h2>
          <p>
            We make reasonable efforts to develop secure open-source software, but we cannot guarantee
            that your data will never be accessed, lost, or compromised. You and your operator are
            responsible for securing your deployment — including HTTPS, firewalls, software updates,
            strong passwords, and regular backups.
          </p>
        </section>

        <section className="legal-section">
          <h2>AI and external services</h2>
          <p>
            If you connect external AI providers (such as Ollama, MCP tools, or other LLM services),
            task and agent session content may be sent to those services according to your configuration. Review
            the privacy policies of any AI providers you connect.
          </p>
        </section>

        <section className="legal-section">
          <h2>Email</h2>
          <p>
            If SMTP is configured, QTask sends transactional emails for account verification and
            password reset. Email content is limited to these authentication flows.
          </p>
        </section>

        <section className="legal-section">
          <h2>Data retention</h2>
          <p>
            Your data persists in the database until you or the operator deletes it. Deleting your account
            on a QTask instance removes your associated data from that instance.
          </p>
        </section>

        <section className="legal-section">
          <h2>Your rights</h2>
          <p>
            To access, correct, or delete your data, contact the operator of the QTask instance you use,
            or use account management features available on that instance.
          </p>
        </section>

        <section className="legal-section">
          <h2>Open source</h2>
          <p>
            QTask source code is available on{' '}
            <a href={GITHUB_REPO_URL} rel="noopener noreferrer">
              GitHub
            </a>
            . Developers are welcome to inspect, fork, and contribute to the project.
          </p>
        </section>

        <section className="legal-section">
          <h2>Changes</h2>
          <p>
            This policy may be updated from time to time. The version number at the top of this page
            indicates the current version.
          </p>
        </section>

        <p className="legal-crosslink muted">
          See also <a href="/terms">Terms &amp; Disclaimer</a>.
        </p>

        <a className="auth-link" href="/">
          {user ? 'Back to QTask' : 'Back to home'}
        </a>
      </div>
    </div>
  );
}
