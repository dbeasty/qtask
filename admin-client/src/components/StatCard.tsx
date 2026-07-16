interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'ok' | 'warn' | 'bad';
}

export function StatCard({ label, value, hint, tone = 'default' }: StatCardProps) {
  return (
    <div className={`stat-card stat-card--${tone}`}>
      <span className="stat-card-label">{label}</span>
      <span className="stat-card-value">{value}</span>
      {hint && <span className="stat-card-hint muted">{hint}</span>}
    </div>
  );
}
