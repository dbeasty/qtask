import type { AppNotification, ProjectInvite } from '@qtask/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  acceptInvite,
  declineInvite,
  listInvites,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../api/client';

function describeNotification(n: AppNotification): string {
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

export function NotificationsScreen() {
  const queryClient = useQueryClient();

  const invitesQuery = useQuery({ queryKey: ['invites'], queryFn: listInvites });
  const notificationsQuery = useQuery({ queryKey: ['notifications'], queryFn: listNotifications });

  const invalidateInvites = () => {
    queryClient.invalidateQueries({ queryKey: ['invites'] });
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    queryClient.invalidateQueries({ queryKey: ['unread-count'] });
    queryClient.invalidateQueries({ queryKey: ['projects'] });
  };

  const accept = useMutation({ mutationFn: acceptInvite, onSuccess: invalidateInvites });
  const decline = useMutation({ mutationFn: declineInvite, onSuccess: invalidateInvites });

  const markRead = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['unread-count'] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['unread-count'] });
    },
  });

  const refreshing = invitesQuery.isRefetching || notificationsQuery.isRefetching;
  const refetchAll = () => {
    invitesQuery.refetch();
    notificationsQuery.refetch();
  };

  if (invitesQuery.isLoading || notificationsQuery.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const invites = invitesQuery.data ?? [];
  const notifications = notificationsQuery.data ?? [];
  const hasUnread = notifications.some((n) => !n.read);

  return (
    <FlatList
      style={styles.container}
      onRefresh={refetchAll}
      refreshing={refreshing}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <>
          {invites.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Pending invites</Text>
              {invites.map((invite: ProjectInvite) => (
                <View key={invite._id} style={styles.inviteCard}>
                  <Text style={styles.inviteText}>
                    {invite.inviterDisplayName ?? invite.inviterEmail} invited you to "{invite.projectName}" as{' '}
                    {invite.role}
                  </Text>
                  <View style={styles.inviteActions}>
                    <TouchableOpacity
                      style={[styles.inviteButton, styles.declineButton]}
                      onPress={() => decline.mutate(invite._id)}
                    >
                      <Text style={styles.declineButtonText}>Decline</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.inviteButton, styles.acceptButton]}
                      onPress={() => accept.mutate(invite._id)}
                    >
                      <Text style={styles.acceptButtonText}>Accept</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Notifications</Text>
            {hasUnread ? (
              <TouchableOpacity onPress={() => markAllRead.mutate()}>
                <Text style={styles.markAllText}>Mark all read</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </>
      }
      data={notifications}
      keyExtractor={(item: AppNotification) => item._id}
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.empty}>No notifications.</Text>
        </View>
      }
      renderItem={({ item }: { item: AppNotification }) => (
        <TouchableOpacity
          style={[styles.notificationRow, !item.read && styles.notificationUnread]}
          onPress={() => !item.read && markRead.mutate(item._id)}
        >
          <Text style={styles.notificationText}>{describeNotification(item)}</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  list: { padding: 16, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  empty: { color: '#888' },
  section: { marginBottom: 16 },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#555', textTransform: 'uppercase' },
  markAllText: { color: '#2563eb', fontSize: 13 },
  inviteCard: {
    backgroundColor: '#eef4ff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  inviteText: { fontSize: 14, marginBottom: 10 },
  inviteActions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  inviteButton: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  declineButton: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#ccc' },
  declineButtonText: { color: '#555', fontWeight: '600' },
  acceptButton: { backgroundColor: '#2563eb' },
  acceptButtonText: { color: '#fff', fontWeight: '600' },
  notificationRow: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#f5f5f7',
    borderRadius: 10,
    marginBottom: 8,
  },
  notificationUnread: { backgroundColor: '#eef4ff' },
  notificationText: { fontSize: 14 },
});
