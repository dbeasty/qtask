import type { AppNotification } from '@qtask/shared';
import { describeNotification } from './notificationText';

function makeNotification(overrides: Partial<AppNotification>): AppNotification {
  return {
    _id: 'n1',
    type: 'project_invite',
    payload: {},
    read: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as AppNotification;
}

describe('describeNotification', () => {
  it('describes a project invite using the inviter display name when present', () => {
    const n = makeNotification({
      type: 'project_invite',
      payload: { inviterDisplayName: 'Ada', inviterEmail: 'ada@example.com', projectName: 'Launch' },
    });
    expect(describeNotification(n)).toBe('Ada invited you to "Launch"');
  });

  it('falls back to the inviter email when no display name is set', () => {
    const n = makeNotification({
      type: 'project_invite',
      payload: { inviterEmail: 'ada@example.com', projectName: 'Launch' },
    });
    expect(describeNotification(n)).toBe('ada@example.com invited you to "Launch"');
  });

  it('describes a share-accepted notification', () => {
    const n = makeNotification({
      type: 'project_share_accepted',
      payload: { inviteeDisplayName: 'Bob', projectName: 'Launch' },
    });
    expect(describeNotification(n)).toBe('Bob accepted your invite to "Launch"');
  });

  it('describes a share-declined notification', () => {
    const n = makeNotification({
      type: 'project_share_declined',
      payload: { inviteeEmail: 'bob@example.com', projectName: 'Launch' },
    });
    expect(describeNotification(n)).toBe('bob@example.com declined your invite to "Launch"');
  });

  it('describes a task comment notification', () => {
    const n = makeNotification({
      type: 'task_comment',
      payload: { authorDisplayName: 'Carl', taskTitle: 'Ship it' },
    });
    expect(describeNotification(n)).toBe('Carl commented on "Ship it"');
  });

  it('describes a task comment reply the same way as a comment', () => {
    const n = makeNotification({
      type: 'task_comment_reply',
      payload: { authorEmail: 'carl@example.com', taskTitle: 'Ship it' },
    });
    expect(describeNotification(n)).toBe('carl@example.com commented on "Ship it"');
  });

  it('uses the reason for a rejected-feedback notification', () => {
    const n = makeNotification({
      type: 'feedback_rejected',
      payload: { reason: 'Duplicate of an existing report' },
    });
    expect(describeNotification(n)).toBe('Duplicate of an existing report');
  });

  it('falls back to a generic message for rejected feedback with no reason', () => {
    const n = makeNotification({ type: 'feedback_rejected', payload: {} });
    expect(describeNotification(n)).toBe('Your feedback was not accepted');
  });

  it('uses the reply text for a feedback-reply notification', () => {
    const n = makeNotification({
      type: 'feedback_reply',
      payload: { reply: 'Thanks, fixed in the next release.' },
    });
    expect(describeNotification(n)).toBe('Thanks, fixed in the next release.');
  });

  it('falls back to a generic message for an unrecognized notification type', () => {
    const n = makeNotification({ type: 'something_new' as AppNotification['type'], payload: {} });
    expect(describeNotification(n)).toBe('Notification');
  });
});
