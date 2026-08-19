import type { AppNotification } from '@qtask/shared';

export function describeNotification(n: AppNotification): string {
  switch (n.type) {
    case 'project_invite':
      return `${n.payload.inviterDisplayName ?? n.payload.inviterEmail} invited you to "${n.payload.projectName}"`;
    case 'project_share_accepted':
      return `${n.payload.inviteeDisplayName ?? n.payload.inviteeEmail} accepted your invite to "${n.payload.projectName}"`;
    case 'project_share_declined':
      return `${n.payload.inviteeDisplayName ?? n.payload.inviteeEmail} declined your invite to "${n.payload.projectName}"`;
    case 'task_comment':
    case 'task_comment_reply':
      return `${n.payload.authorDisplayName ?? n.payload.authorEmail} commented on "${n.payload.taskTitle}"`;
    case 'feedback_rejected':
      return n.payload.reason ?? 'Your feedback was not accepted';
    case 'feedback_reply':
      return n.payload.reply ?? 'You have a reply to your feedback';
    default:
      return n.payload.message ?? 'Notification';
  }
}
