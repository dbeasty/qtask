import { useEffect, useState } from 'react';
import { verifyEmail } from '../auth/storage';

type Status = 'loading' | 'success' | 'error';

export function VerifyEmailPage() {
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('Verifying your email…');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) {
      setStatus('error');
      setMessage('Missing verification token.');
      return;
    }

    verifyEmail(token)
      .then((result) => {
        setStatus('success');
        setMessage(result.message);
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'Verification failed');
      });
  }, []);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Email verification</h1>
        <p className={status === 'error' ? 'auth-error' : status === 'success' ? 'auth-success' : 'muted'}>
          {message}
        </p>
        {status !== 'loading' && (
          <a className="auth-link" href="/login">
            Go to sign in
          </a>
        )}
      </div>
    </div>
  );
}
