import type { UserSummary } from '../types';

interface UserIdentityProps {
  user: UserSummary;
  you?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function formatUserLabel(user: UserSummary, you = false): string {
  if (you) return 'You';
  return user.displayName?.trim() || user.email;
}

export function UserIdentity({ user, you = false, size = 'md', className }: UserIdentityProps) {
  const primary = formatUserLabel(user, you);
  const showEmail = Boolean(user.displayName?.trim()) && !you;

  return (
    <div
      className={`user-identity user-identity--${size}${className ? ` ${className}` : ''}`}
    >
      <span className="user-identity-primary">{primary}</span>
      {showEmail ? <span className="user-identity-secondary muted">{user.email}</span> : null}
    </div>
  );
}
