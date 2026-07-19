import { useAuth } from '../auth/AuthContext';
import { GITHUB_REPO_URL, SITE_URL } from '../constants/brand';

export function TermsPage() {
  const { user } = useAuth();

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide legal-page">
        <h1>Terms &amp; Disclaimer</h1>
        <p className="muted legal-version">Version 1.1</p>

        <section className="legal-section">
          <h2>About QTask</h2>
          <p>
            QTask is open-source software for AI-native task management. You may self-host it or run it
            in an environment you control. The official deployment is at{' '}
            <a href={SITE_URL}>{SITE_URL}</a>. Source code and contributions are welcome on{' '}
            <a href={GITHUB_REPO_URL} rel="noopener noreferrer">
              GitHub
            </a>
            . These terms apply to your use of the QTask software.
          </p>
        </section>

        <section className="legal-section">
          <h2>No warranty</h2>
          <p>
            QTask is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranty of any
            kind, express or implied, including but not limited to warranties of merchantability, fitness
            for a particular purpose, and non-infringement.
          </p>
        </section>

        <section className="legal-section">
          <h2>Data safety</h2>
          <p>
            QTask does not guarantee the safety, integrity, availability, or confidentiality of your
            data. Data you store in or through QTask may be lost, corrupted, deleted, or accessed without
            authorization — including as a result of hacking, misconfiguration, hardware or software
            failure, or other causes. You are responsible for maintaining your own backups and must not
            rely on QTask as the sole copy of important information.
          </p>
        </section>

        <section className="legal-section">
          <h2>Limitation of liability</h2>
          <p>
            To the fullest extent permitted by law, the authors and contributors of QTask shall not be
            liable for any direct, indirect, incidental, special, consequential, or punitive damages
            arising from your use of the software. This includes, without limitation, liability for data
            going missing or being lost, data being hacked or otherwise accessed without authorization,
            security breaches, service downtime, or errors in AI-generated output.
          </p>
        </section>

        <section className="legal-section">
          <h2>Your responsibility</h2>
          <p>
            If you deploy or operate a QTask instance, you are responsible for securing it, backing up
            your data, and ensuring your use complies with applicable laws. AI suggestions are for
            productivity assistance only and do not constitute professional, legal, financial, or medical
            advice.
          </p>
        </section>

        <section className="legal-section">
          <h2>Self-hosted software</h2>
          <p>
            QTask is designed to be self-hosted. Security, availability, updates, and regulatory
            compliance for any particular deployment are the responsibility of the person or organization
            operating that instance.
          </p>
        </section>

        <section className="legal-section">
          <h2>Changes</h2>
          <p>
            These terms may be updated from time to time. The version number at the top of this page
            indicates the current version. Continued use after changes are published may constitute
            acceptance of the updated terms for new registrations.
          </p>
        </section>

        <p className="legal-crosslink muted">
          See also <a href="/privacy">Privacy Policy</a>.
        </p>

        <a className="auth-link" href="/">
          {user ? 'Back to QTask' : 'Back to home'}
        </a>
      </div>
    </div>
  );
}
