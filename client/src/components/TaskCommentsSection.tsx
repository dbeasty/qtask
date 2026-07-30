import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createTaskComment,
  deleteTaskComment,
  getTaskComments,
  updateTaskComment,
} from '../api/client';
import type { Comment } from '../types';
import { AutoResizeTextarea } from './AutoResizeTextarea';
import { formatActivityTimestamp } from '../utils/formatActivity';

interface TaskCommentsSectionProps {
  taskId: string;
  subtaskPath?: string[];
  currentUserId: string;
  canComment: boolean;
  canModerate: boolean;
  refreshKey?: number;
}

type CommentNode = Comment & { replies: CommentNode[] };

function authorLabel(comment: Comment): string {
  return comment.author.displayName || comment.author.email;
}

function buildCommentTree(comments: Comment[]): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const comment of comments) {
    nodes.set(comment._id, { ...comment, replies: [] });
  }

  const roots: CommentNode[] = [];
  for (const comment of comments) {
    const node = nodes.get(comment._id)!;
    if (comment.parentId && nodes.has(comment.parentId)) {
      nodes.get(comment.parentId)!.replies.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function CommentItem({
  comment,
  depth,
  currentUserId,
  canComment,
  canModerate,
  replyingToId,
  onReply,
  onCancelReply,
  onSubmitReply,
  onEdit,
  onDelete,
  replyDraft,
  onReplyDraftChange,
  notifyByEmail,
  onNotifyByEmailChange,
  submitting,
}: {
  comment: CommentNode;
  depth: number;
  currentUserId: string;
  canComment: boolean;
  canModerate: boolean;
  replyingToId: string | null;
  onReply: (commentId: string) => void;
  onCancelReply: () => void;
  onSubmitReply: (parentId: string) => void;
  onEdit: (comment: Comment) => void;
  onDelete: (commentId: string) => void;
  replyDraft: string;
  onReplyDraftChange: (value: string) => void;
  notifyByEmail: boolean;
  onNotifyByEmailChange: (value: boolean) => void;
  submitting: boolean;
}) {
  const timestamp = formatActivityTimestamp(comment.createdAt);
  const canEdit = comment.userId === currentUserId;
  const canDelete = canEdit || canModerate;
  const isReplying = replyingToId === comment._id;

  return (
    <li className={`comment-item${depth > 0 ? ' comment-reply' : ''}`} style={{ marginLeft: depth > 0 ? `${Math.min(depth, 5) * 1.25}rem` : undefined }}>
      <div className="comment-item-main">
        <div className="comment-item-content">
          <p className="comment-item-author">
            {authorLabel(comment)}
            {comment.userId === currentUserId ? <span className="comment-item-you"> · You</span> : null}
          </p>
          <p className="comment-item-body">{comment.body}</p>
          {comment.editedAt ? <p className="comment-item-edited muted">Edited</p> : null}
        </div>
        <div className="comment-item-meta">
          <time className="comment-item-time" dateTime={comment.createdAt} title={timestamp.absolute}>
            {timestamp.relative}
          </time>
        </div>
      </div>
      <div className="comment-item-actions">
        {canComment ? (
          <button type="button" className="link-button" onClick={() => onReply(comment._id)}>
            Reply
          </button>
        ) : null}
        {canEdit ? (
          <button type="button" className="link-button" onClick={() => onEdit(comment)}>
            Edit
          </button>
        ) : null}
        {canDelete ? (
          <button type="button" className="link-button comment-delete-button" onClick={() => onDelete(comment._id)}>
            Delete
          </button>
        ) : null}
      </div>

      {isReplying ? (
        <div className="comment-reply-form">
          <AutoResizeTextarea
            value={replyDraft}
            onChange={(event) => onReplyDraftChange(event.target.value)}
            placeholder="Write a reply…"
            disabled={submitting}
          />
          <label className="comment-notify-email">
            <input
              type="checkbox"
              checked={notifyByEmail}
              onChange={(event) => onNotifyByEmailChange(event.target.checked)}
              disabled={submitting}
            />
            Notify collaborators by email
          </label>
          <div className="comment-form-actions">
            <button
              type="button"
              className="primary-button"
              disabled={submitting || !replyDraft.trim()}
              onClick={() => onSubmitReply(comment._id)}
            >
              Reply
            </button>
            <button type="button" className="secondary-button" disabled={submitting} onClick={onCancelReply}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {comment.replies.length > 0 ? (
        <ul className="comment-list comment-thread">
          {comment.replies.map((reply) => (
            <CommentItem
              key={reply._id}
              comment={reply}
              depth={depth + 1}
              currentUserId={currentUserId}
              canComment={canComment}
              canModerate={canModerate}
              replyingToId={replyingToId}
              onReply={onReply}
              onCancelReply={onCancelReply}
              onSubmitReply={onSubmitReply}
              onEdit={onEdit}
              onDelete={onDelete}
              replyDraft={replyDraft}
              onReplyDraftChange={onReplyDraftChange}
              notifyByEmail={notifyByEmail}
              onNotifyByEmailChange={onNotifyByEmailChange}
              submitting={submitting}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function TaskCommentsSection({
  taskId,
  subtaskPath,
  currentUserId,
  canComment,
  canModerate,
  refreshKey = 0,
}: TaskCommentsSectionProps) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [replyDraft, setReplyDraft] = useState('');
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [notifyByEmail, setNotifyByEmail] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const requestIdRef = useRef(0);
  const hasFetchedRef = useRef(false);

  const scopedPath = subtaskPath ?? [];

  const loadComments = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const { comments: nextComments } = await getTaskComments(taskId, scopedPath);
      if (requestId !== requestIdRef.current) return;
      setComments(nextComments);
      hasFetchedRef.current = true;
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load comments');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [taskId, scopedPath.join(',')]);

  useEffect(() => {
    requestIdRef.current += 1;
    setComments([]);
    setError(null);
    setDraft('');
    setReplyDraft('');
    setReplyingToId(null);
    setEditingId(null);
    setEditDraft('');
    setNotifyByEmail(false);
    hasFetchedRef.current = false;
  }, [taskId, scopedPath.join(','), refreshKey]);

  useEffect(() => {
    if (!open) return;
    void loadComments();
  }, [open, taskId, scopedPath.join(','), refreshKey, loadComments]);

  const commentTree = useMemo(() => buildCommentTree(comments), [comments]);

  async function handleCreate(parentId?: string) {
    const body = (parentId ? replyDraft : draft).trim();
    if (!body) return;

    setSubmitting(true);
    setError(null);
    try {
      await createTaskComment(taskId, {
        body,
        subtaskPath: scopedPath.length > 0 ? scopedPath : undefined,
        parentId,
        notifyByEmail,
      });
      if (parentId) {
        setReplyDraft('');
        setReplyingToId(null);
      } else {
        setDraft('');
      }
      setNotifyByEmail(false);
      await loadComments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveEdit(commentId: string) {
    const body = editDraft.trim();
    if (!body) return;

    setSubmitting(true);
    setError(null);
    try {
      await updateTaskComment(taskId, commentId, { body });
      setEditingId(null);
      setEditDraft('');
      await loadComments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update comment');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(commentId: string) {
    setSubmitting(true);
    setError(null);
    try {
      await deleteTaskComment(taskId, commentId);
      await loadComments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete comment');
    } finally {
      setSubmitting(false);
    }
  }

  function handleToggle(event: React.SyntheticEvent<HTMLDetailsElement>) {
    setOpen(event.currentTarget.open);
  }

  return (
    <details className="task-form-tracking-section" open={open} onToggle={handleToggle}>
      <summary className="task-form-tracking-summary">
        <span className={`project-toolbar-chevron${open ? ' expanded' : ''}`} aria-hidden="true">
          ›
        </span>
        Comments
      </summary>
      <div className="task-form-tracking-body">
        {canComment ? (
          <div className="comment-composer">
            {editingId ? (
              <>
                <AutoResizeTextarea
                  value={editDraft}
                  onChange={(event) => setEditDraft(event.target.value)}
                  placeholder="Edit comment…"
                  disabled={submitting}
                />
                <div className="comment-form-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={submitting || !editDraft.trim()}
                    onClick={() => void handleSaveEdit(editingId)}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={submitting}
                    onClick={() => {
                      setEditingId(null);
                      setEditDraft('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <AutoResizeTextarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Write a comment…"
                  disabled={submitting}
                />
                <label className="comment-notify-email">
                  <input
                    type="checkbox"
                    checked={notifyByEmail}
                    onChange={(event) => setNotifyByEmail(event.target.checked)}
                    disabled={submitting}
                  />
                  Notify collaborators by email
                </label>
                <div className="comment-form-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={submitting || !draft.trim()}
                    onClick={() => void handleCreate()}
                  >
                    Post
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {loading && (
          <p className="muted" aria-live="polite">
            Loading comments…
          </p>
        )}

        {!loading && error && <p className="error-banner">{error}</p>}

        {!loading && !error && comments.length === 0 && hasFetchedRef.current && (
          <p className="muted" aria-live="polite">
            No comments yet.
          </p>
        )}

        {!loading && !error && commentTree.length > 0 && (
          <ul className="comment-list">
            {commentTree.map((comment) => (
              <CommentItem
                key={comment._id}
                comment={comment}
                depth={0}
                currentUserId={currentUserId}
                canComment={canComment}
                canModerate={canModerate}
                replyingToId={replyingToId}
                onReply={(commentId) => {
                  setReplyingToId(commentId);
                  setReplyDraft('');
                }}
                onCancelReply={() => {
                  setReplyingToId(null);
                  setReplyDraft('');
                }}
                onSubmitReply={(parentId) => void handleCreate(parentId)}
                onEdit={(target) => {
                  setEditingId(target._id);
                  setEditDraft(target.body);
                  setDraft('');
                }}
                onDelete={(commentId) => void handleDelete(commentId)}
                replyDraft={replyDraft}
                onReplyDraftChange={setReplyDraft}
                notifyByEmail={notifyByEmail}
                onNotifyByEmailChange={setNotifyByEmail}
                submitting={submitting}
              />
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
