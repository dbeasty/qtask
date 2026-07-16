import { useCallback, useEffect, useState } from 'react';
import { AuthError, fetchStats, listUsers } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { DeleteUserDialog } from '../components/DeleteUserDialog';
import { Pagination } from '../components/Pagination';
import { ResetPasswordDialog } from '../components/ResetPasswordDialog';
import { StatCard } from '../components/StatCard';
import { formatBytes, formatDate, formatNumber } from '../utils/format';
import type { AdminStats, AdminUser } from '../types';

const PAGE_SIZE = 20;

export function UsersPage() {
  const { handleSessionExpired } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof AuthError) {
        handleSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : 'Request failed');
    },
    [handleSessionExpired]
  );

  useEffect(() => {
    fetchStats().then(setStats).catch(handleError);
  }, [handleError, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listUsers({ page, limit: PAGE_SIZE, search: appliedSearch || undefined })
      .then((result) => {
        if (cancelled) return;
        setUsers(result.users);
        setTotal(result.total);
      })
      .catch((err) => {
        if (!cancelled) handleError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, appliedSearch, refreshKey, handleError]);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  return (
    <div className="page">
      <section className="stat-grid">
        <StatCard label="Users" value={formatNumber(stats?.users)} />
        <StatCard label="Projects" value={formatNumber(stats?.projects)} />
        <StatCard label="Tasks" value={formatNumber(stats?.tasks)} />
        <StatCard label="Conversations" value={formatNumber(stats?.conversations)} />
        <StatCard
          label="Stored data"
          value={stats ? formatBytes(stats.totalDataBytes) : '—'}
          hint={stats ? `${formatNumber(stats.activities)} activity records` : undefined}
        />
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Users</h2>
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setAppliedSearch(search.trim());
            }}
          >
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by email or name"
            />
            <button type="submit">Search</button>
          </form>
        </div>

        {error && <p className="panel-error">{error}</p>}

        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Status</th>
              <th>Joined</th>
              <th>Last login</th>
              <th>Last used</th>
              <th className="num">Projects</th>
              <th className="num">Tasks</th>
              <th className="num">Data</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr>
                <td colSpan={10} className="muted table-status">
                  Loading…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={10} className="muted table-status">
                  No users found.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.id}>
                  <td className="cell-email">{user.email}</td>
                  <td>{user.displayName ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge ${user.active ? 'badge--ok' : 'badge--warn'}`}>
                      {user.active ? 'Active' : user.emailVerified ? 'Never used' : 'Unverified'}
                    </span>
                  </td>
                  <td>{formatDate(user.createdAt)}</td>
                  <td>{user.lastLoginAt ? formatDate(user.lastLoginAt) : <span className="muted">Never</span>}</td>
                  <td>{user.lastActiveAt ? formatDate(user.lastActiveAt) : <span className="muted">Never</span>}</td>
                  <td className="num">{formatNumber(user.projectCount)}</td>
                  <td className="num">{formatNumber(user.taskCount)}</td>
                  <td className="num">{formatBytes(user.storageBytes)}</td>
                  <td className="actions-col">
                    <button type="button" onClick={() => setResetTarget(user)}>
                      Reset password
                    </button>
                    <button
                      type="button"
                      className="btn-danger-outline"
                      onClick={() => setDeleteTarget(user)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
          disabled={loading}
        />
      </section>

      {resetTarget && (
        <ResetPasswordDialog user={resetTarget} onClose={() => setResetTarget(null)} />
      )}
      {deleteTarget && (
        <DeleteUserDialog
          user={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={refresh}
        />
      )}
    </div>
  );
}
