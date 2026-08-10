import { useCallback, useEffect, useState } from 'react';
import { AuthError, getFeedback, listFeedback, updateFeedbackStatus } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Pagination } from '../components/Pagination';
import { formatDate, formatNumber } from '../utils/format';
import type { AdminFeedbackDetail, AdminFeedbackItem, FeedbackStatus } from '../types';

const PAGE_SIZE = 20;

function validationBadgeClass(status: AdminFeedbackItem['validationStatus']): string {
  switch (status ?? 'validated') {
    case 'validated':
      return 'badge badge--ok';
    case 'pending':
      return 'badge badge--warn';
    case 'rejected':
    case 'failed':
      return 'badge badge--bad';
    default:
      return 'badge badge--ok';
  }
}

function statusBadgeClass(status: FeedbackStatus): string {
  return `badge badge--${status}`;
}

function statusLabel(status: FeedbackStatus): string {
  return status === 'resolved' ? 'handled' : status;
}

export function FeedbackPage() {
  const { handleSessionExpired } = useAuth();
  const [items, setItems] = useState<AdminFeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | FeedbackStatus>('open');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminFeedbackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const [replySaving, setReplySaving] = useState(false);

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

  const applyStatusUpdate = useCallback(
    (id: string, nextStatus: FeedbackStatus, adminReply?: AdminFeedbackDetail['adminReply']) => {
      setDetail((current) =>
        current && current.id === id
          ? { ...current, status: nextStatus, ...(adminReply !== undefined ? { adminReply } : {}) }
          : current
      );
      setItems((current) =>
        current.map((item) => (item.id === id ? { ...item, status: nextStatus } : item))
      );
    },
    []
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
      setReplyDraft('');
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    getFeedback(selectedId)
      .then(async (result) => {
        if (cancelled) return;
        setDetail(result);
        setReplyDraft('');
        if (result.status === 'open') {
          try {
            const updated = await updateFeedbackStatus(result.id, { status: 'read' });
            if (cancelled) return;
            applyStatusUpdate(result.id, updated.status);
          } catch (err) {
            if (!cancelled) handleError(err);
          }
        }
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
  }, [selectedId, handleError, applyStatusUpdate]);

  async function handleStatusChange(nextStatus: FeedbackStatus) {
    if (!detail) return;
    setStatusSaving(true);
    setError(null);
    try {
      const updated = await updateFeedbackStatus(detail.id, { status: nextStatus });
      applyStatusUpdate(detail.id, updated.status, updated.adminReply ?? detail.adminReply);
    } catch (err) {
      handleError(err);
    } finally {
      setStatusSaving(false);
    }
  }

  async function handleSendReply() {
    if (!detail || !replyDraft.trim()) return;
    setReplySaving(true);
    setError(null);
    try {
      const updated = await updateFeedbackStatus(detail.id, { reply: replyDraft.trim() });
      applyStatusUpdate(detail.id, updated.status, updated.adminReply ?? null);
      setReplyDraft('');
    } catch (err) {
      handleError(err);
    } finally {
      setReplySaving(false);
    }
  }

  function attachmentUrl(feedbackId: string, index: number): string {
    return `/api/admin/feedback/${encodeURIComponent(feedbackId)}/attachments/${index}`;
  }

  return (
    <div className="page page--wide">
      <div className="feedback-layout">
        <section className="panel feedback-list-panel">
          <div className="panel-header">
            <h2>Feedback</h2>
            <div className="panel-actions">
              <div className="panel-filter">
                <span className="muted">Status</span>
                <select
                  className="panel-select"
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value as typeof statusFilter);
                    setPage(1);
                  }}
                >
                  <option value="open">Open</option>
                  <option value="read">Read</option>
                  <option value="resolved">Handled</option>
                  <option value="all">All statuses</option>
                </select>
              </div>
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

        {error ? <p className="panel-error">{error}</p> : null}

        <div className="table-wrap">
          <table className="data-table feedback-table">
            <thead>
              <tr>
                <th className="col-date">Date</th>
                <th className="col-user">User</th>
                <th className="col-category">Category</th>
                <th className="col-status">Status</th>
                <th className="col-validation">Validation</th>
                <th className="col-message">Message</th>
                <th className="num col-shots">Screenshots</th>
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
                    <span className={statusBadgeClass(item.status)}>{statusLabel(item.status)}</span>
                  </td>
                  <td>
                    <span className={validationBadgeClass(item.validationStatus)}>
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
        </div>

        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
          disabled={loading}
        />
        </section>

        <section className="panel feedback-detail-panel">
        <div className="panel-header">
          <h2>Details</h2>
        </div>
        {!selectedId ? (
          <p className="muted">Select a feedback item to view details.</p>
        ) : detailLoading ? (
          <p className="muted">Loading details…</p>
        ) : detail ? (
          <div className="feedback-detail">
            <div className="feedback-detail-header">
              <div>
                <p className="feedback-detail-user">
                  <strong>{detail.userEmail ?? detail.userId}</strong>
                  {detail.userDisplayName ? (
                    <span className="muted"> ({detail.userDisplayName})</span>
                  ) : null}
                </p>
                <p className="feedback-detail-meta muted">
                  {formatDate(detail.createdAt)} · {detail.category}
                </p>
              </div>
              <div className="feedback-detail-badges">
                <span className={validationBadgeClass(detail.validationStatus)}>
                  {detail.validationStatus ?? 'validated'}
                </span>
                <span className={statusBadgeClass(detail.status)}>{statusLabel(detail.status)}</span>
              </div>
            </div>

            <div className="feedback-detail-actions">
              {detail.status === 'open' ? (
                <button
                  type="button"
                  disabled={statusSaving}
                  onClick={() => void handleStatusChange('read')}
                >
                  Mark as read
                </button>
              ) : null}
              {detail.status !== 'resolved' ? (
                <button
                  type="button"
                  disabled={statusSaving}
                  onClick={() => void handleStatusChange('resolved')}
                >
                  Mark as handled
                </button>
              ) : null}
              {detail.status !== 'open' ? (
                <button
                  type="button"
                  disabled={statusSaving}
                  onClick={() => void handleStatusChange('open')}
                >
                  Reopen
                </button>
              ) : null}
            </div>

            <div className="feedback-message">
              <h3 className="feedback-section-title">Message</h3>
              <p>{detail.message}</p>
            </div>

            {detail.context?.url || detail.context?.userAgent ? (
              <div className="feedback-context">
                <h3 className="feedback-section-title">Context</h3>
                {detail.context?.url ? (
                  <p>
                    <span className="muted">URL</span>
                    <code className="feedback-code">{detail.context.url}</code>
                  </p>
                ) : null}
                {detail.context?.userAgent ? (
                  <p>
                    <span className="muted">User agent</span>
                    <code className="feedback-code">{detail.context.userAgent}</code>
                  </p>
                ) : null}
              </div>
            ) : null}
            {detail.attachments.length > 0 ? (
              <div className="feedback-attachments">
                <h3 className="feedback-section-title">Screenshots</h3>
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

            {detail.adminReply ? (
              <div className="feedback-admin-reply">
                <h3 className="feedback-section-title">Reply sent</h3>
                <p className="feedback-admin-reply-meta muted">
                  {formatDate(detail.adminReply.repliedAt)}
                </p>
                <p>{detail.adminReply.message}</p>
              </div>
            ) : (
              <div className="feedback-reply-form">
                <label htmlFor="feedback-reply">
                  <span className="feedback-section-title">Reply to user</span>
                  <textarea
                    id="feedback-reply"
                    rows={4}
                    value={replyDraft}
                    disabled={replySaving}
                    placeholder="Let the user know what was fixed or why no change was needed."
                    onChange={(event) => setReplyDraft(event.target.value)}
                  />
                </label>
                <div className="feedback-detail-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={replySaving || !replyDraft.trim()}
                    onClick={() => void handleSendReply()}
                  >
                    {replySaving ? 'Sending…' : 'Send reply & mark handled'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="muted">Feedback not found.</p>
        )}
        </section>
      </div>
    </div>
  );
}
