import { useEffect, useState } from 'react';
import { checkHealth } from '../api/client';
import { GITHUB_REPO_URL, SITE_URL } from '../constants/brand';

interface AboutPageProps {
  apiVersion?: string | null;
  aiVersion?: string | null;
  onBack?: () => void;
}

export function AboutPage({
  apiVersion: apiVersionProp,
  aiVersion: aiVersionProp,
  onBack,
}: AboutPageProps) {
  const [apiVersion, setApiVersion] = useState<string | null>(apiVersionProp ?? null);
  const [aiVersion, setAiVersion] = useState<string | null>(aiVersionProp ?? null);
  const [apiStatus, setApiStatus] = useState<string | null>(null);

  useEffect(() => {
    if (apiVersionProp !== undefined) {
      setApiVersion(apiVersionProp);
      setAiVersion(aiVersionProp ?? null);
      return;
    }

    checkHealth()
      .then((result) => {
        setApiStatus(result.status);
        if (result.version) setApiVersion(result.version);
        setAiVersion(result.aiVersion ?? null);
      })
      .catch(() => {
        setApiStatus('offline');
      });
  }, [apiVersionProp, aiVersionProp]);

  const aiVersionLabel =
    aiVersion ??
    (apiStatus === 'offline'
      ? 'Unavailable'
      : apiVersion != null
        ? 'Unavailable'
        : 'Checking…');

  return (
    <div className="about-page">
      <div className="about-page-inner">
        <div className="page-header">
          <h2>About QTask</h2>
          {onBack ? (
            <div className="page-header-actions">
              <button type="button" className="secondary-button" onClick={onBack}>
                Back
              </button>
            </div>
          ) : null}
        </div>

        <p className="muted about-intro">
          AI-native task management with projects, nested tasks, and an assistant that can help you
          organize work in natural language.
        </p>

        <section className="about-section">
          <h3>Version</h3>
          <dl className="about-version-list">
            <div className="about-version-row">
              <dt>Web client</dt>
              <dd>{__APP_VERSION__}</dd>
            </div>
            <div className="about-version-row">
              <dt>API server</dt>
              <dd>
                {apiVersion ?? (apiStatus === 'offline' ? 'Unavailable' : 'Checking…')}
              </dd>
            </div>
            <div className="about-version-row">
              <dt>AI server</dt>
              <dd>{aiVersionLabel}</dd>
            </div>
          </dl>
          <p className="muted about-version-note">
            The API version reflects the release deployed on the server. The AI server version
            reflects the Jetson Ollama stack and may differ if the Jetson was not redeployed with
            the app. After publishing, confirm all versions match what you expect.
          </p>
        </section>

        <section className="about-section">
          <h3>Links</h3>
          <p>
            Official site:{' '}
            <a href={SITE_URL} rel="noopener noreferrer">
              {SITE_URL}
            </a>
          </p>
          <p>
            Source and contributions:{' '}
            <a href={GITHUB_REPO_URL} rel="noopener noreferrer">
              GitHub
            </a>
          </p>
          <p>
            <a href="/terms">Terms &amp; Disclaimer</a>
            {' · '}
            <a href="/privacy">Privacy Policy</a>
          </p>
        </section>
      </div>
    </div>
  );
}
