import { useCallback, useEffect, useState } from 'react';
import { AuthError, getFeedback, listFeedback, updateFeedbackStatus } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Pagination } from '../components/Pagination';
import { formatDate, formatNumber } from '../utils/format';
import type { AdminFeedbackDetail, AdminFeedbackItem } from '../types';

const PAGE_SIZE = 20;

export function FeedbackPage() {
  const { handleSessionExpired } = useAuth();
  const [items, setItems] = useState<AdminFeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'read' | 'resolved'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminFeedbackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);

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
    let cancelled = false;
    setLoading(true);
    setError(null);
    listFeedback({
      page,
      limit: PAGE_SIZE,
      search: appliedSearch || undefined,
      status: statusFilter === 'all' ? undefined : statusFilter,
    })
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
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
  }, [page, appliedSearch, statusFilter, handleError]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    getFeedback(selectedId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((err) => {
        if (!cancelled) handleError(err);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, handleError]);

  async function handleStatusChange(nextStatus: 'open' | 'read' | 'resolved') {
    if (!detail) return;
    setStatusSaving(true);
    setError(null);
    try {
      await updateFeedbackStatus(detail.id, nextStatus);
      setDetail({ ...detail, status: nextStatus });
      setItems((current) =>
        current.map((item) => (item.id === detail.id ? { ...item, status: nextStatus } : item))
      );
    } catch (err) {
      handleError(err);
    } finally {
      setStatusSaving(false);
    }
  }

  function attachmentUrl(feedbackId: string, index: number): string {
    return `/api/admin/feedback/${encodeURIComponent(feedbackId)}/attachments/${index}`;
  }

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="panel-header">
          <h2>Feedback</h2>
          <div className="panel-actions">
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as typeof statusFilter);
                setPage(1);
              }}
            >
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="read">Read</option>
              <option value="resolved">Resolved</option>
            </select>
            <form
              className="search-form"
              onSubmit={(event) => {
                event.preventDefault();
                setAppliedSearch(search.trim());
                setPage(1);
              }}
            >
              <input
                type="search"
                placeholder="Search message or user"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button type="submit">Search</button>
            </form>
          </div>
        </div>

        {error ? <p className="error-banner">{error}</p> : null}

        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>User</th>
              <th>Category</th>
              <th>Status</th>
              <th>Validation</th>
              <th>Message</th>
              <th className="num">Screenshots</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="muted">
                  Loading…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No feedback yet.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr
                  key={item.id}
                  className={selectedId === item.id ? 'row-selected' : ''}
                  onClick={() => setSelectedId(item.id)}
                >
                  <td>{formatDate(item.createdAt)}</td>
                  <td className="cell-email">{item.userEmail ?? item.userId}</td>
                  <td>{item.category}</td>
                  <td>
                    <span className={`badge badge--${item.status}`}>{item.status}</span>
                  </td>
                  <td>
                    <span className={`badge badge--${item.validationStatus ?? 'validated'}`}>
                      {item.validationStatus ?? 'validated'}
                    </span>
                  </td>
                  <td className="cell-truncate">{item.message}</td>
                  <td className="num">{formatNumber(item.attachmentCount)}</td>
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

      <section className="panel">
        <div className="panel-header">
          <h2>Details</h2>
        </div>
        {!selectedId ? (
          <p className="muted">Select a feedback item to view details.</p>
        ) : detailLoading ? (
          <p className="muted">Loading details…</p>
        ) : detail ? (
          <div className="feedback-detail">
            <p>
              <strong>{detail.userEmail ?? detail.userId}</strong>
              {detail.userDisplayName ? ` (${detail.userDisplayName})` : ''}
            </p>
            <p className="muted">
              {formatDate(detail.createdAt)} · {detail.category} · validation{' '}
              {detail.validationStatus ?? 'validated'}
            </p>
            <label className="field-label" htmlFor="feedback-status">
              Status
            </label>
            <select
              id="feedback-status"
              value={detail.status}
              disabled={statusSaving}
              onChange={(event) =>
                void handleStatusChange(event.target.value as 'open' | 'read' | 'resolved')
              }
            >
              <option value="open">Open</option>
              <option value="read">Read</option>
              <option value="resolved">Resolved</option>
            </select>
            <p>{detail.message}</p>
            {detail.context?.url ? (
              <p className="muted">
                URL: <code>{detail.context.url}</code>
              </p>
            ) : null}
            {detail.context?.userAgent ? (
              <p className="muted">
                User agent: <code>{detail.context.userAgent}</code>
              </p>
            ) : null}
            {detail.attachments.length > 0 ? (
              <div className="feedback-attachments">
                {detail.attachments.map((attachment) => (
                  <figure key={attachment.index} className="feedback-attachment">
                    <img
                      src={attachmentUrl(detail.id, attachment.index)}
                      alt={`Screenshot ${attachment.index + 1}`}
                    />
                    <figcaption className="muted">
                      {attachment.contentType} · {formatNumber(attachment.sizeBytes)} bytes
                      {attachment.visionCheck?.confidence != null
                        ? ` · confidence ${Math.round(attachment.visionCheck.confidence * 100)}%`
                        : attachment.visionCheck
                          ? ''
                          : ' · validation pending'}
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="muted">Feedback not found.</p>
        )}
      </section>
    </div>
  );
}
