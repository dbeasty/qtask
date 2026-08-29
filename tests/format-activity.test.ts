import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatActivityAction,
  formatActivityActor,
  formatActivityDetails,
  formatActivitySourceLabel,
  formatActivityTimestamp,
} from '../client/src/utils/formatActivity.ts';
import type { ActivityEntry } from '../client/src/types.ts';

function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    _id: 'a1',
    taskId: 't1',
    userId: 'u1',
    action: 'task.updated',
    details: {},
    source: 'user',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('formatActivity', () => {
  it('formatActivityAction uses the known label for a mapped action', () => {
    assert.equal(formatActivityAction('task.created'), 'Task created');
    assert.equal(formatActivityAction('subtask.deleted_keep_children'), 'Subtask deleted (children kept)');
  });

  it('formatActivityAction humanizes an unmapped action instead of showing the raw key', () => {
    assert.equal(formatActivityAction('task.some_new_action'), 'Task Some new action');
  });

  it('formatActivityDetails returns null when there are no details', () => {
    assert.equal(formatActivityDetails(makeEntry({ details: {} })), null);
  });

  it('formatActivityDetails lists changed field names for task.updated', () => {
    const result = formatActivityDetails(
      makeEntry({ action: 'task.updated', details: { status: 'done', priority: 'high' } })
    );
    assert.equal(result, 'status, priority');
  });

  it('formatActivityDetails excludes "path" from the changed-field list', () => {
    const result = formatActivityDetails(
      makeEntry({ action: 'subtask.updated', details: { status: 'done', path: ['a', 'b'] } })
    );
    assert.ok(result?.includes('status'));
    assert.ok(!result?.includes('path'));
    // path still renders separately as a breadcrumb.
    assert.ok(result?.includes('a › b'));
  });

  it('formatActivityDetails renders a move as "from → to" when both sides are known', () => {
    const result = formatActivityDetails(
      makeEntry({
        action: 'subtask.moved',
        details: { fromPath: ['a'], toParentPath: ['b', 'c'] },
      })
    );
    assert.equal(result, 'a → b › c');
  });

  it('formatActivityDetails falls back to a raw key:value join when nothing else matched', () => {
    const result = formatActivityDetails(makeEntry({ action: 'custom.thing', details: { count: 3, ok: true } }));
    assert.equal(result, 'count: 3; ok: true');
  });

  it('formatActivityActor labels AI and system sources regardless of userId', () => {
    assert.equal(formatActivityActor(makeEntry({ source: 'ai', userId: 'someone-else' }), 'me'), 'AI');
    assert.equal(formatActivityActor(makeEntry({ source: 'system', userId: 'someone-else' }), 'me'), 'System');
  });

  it('formatActivityActor returns "You" only for the viewing user\'s own entries', () => {
    assert.equal(formatActivityActor(makeEntry({ source: 'user', userId: 'me' }), 'me'), 'You');
    assert.equal(formatActivityActor(makeEntry({ source: 'user', userId: 'someone-else' }), 'me'), null);
  });

  it('formatActivitySourceLabel maps every source to a human label', () => {
    assert.equal(formatActivitySourceLabel('ai'), 'AI');
    assert.equal(formatActivitySourceLabel('system'), 'System');
    assert.equal(formatActivitySourceLabel('user'), 'User');
  });

  it('formatActivityTimestamp reports "just now"-scale relative time for a recent timestamp', () => {
    const { relative, absolute } = formatActivityTimestamp(new Date().toISOString());
    assert.ok(typeof relative === 'string' && relative.length > 0);
    assert.ok(typeof absolute === 'string' && absolute.length > 0);
  });

  it('formatActivityTimestamp reports in days for a multi-day-old timestamp', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { relative } = formatActivityTimestamp(threeDaysAgo);
    assert.match(relative, /day/i);
  });
});
