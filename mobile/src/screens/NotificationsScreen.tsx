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
import { describeNotification } from '../utils/notificationText';

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
                      accessibilityRole="button"
                      accessibilityLabel={`Decline invite to ${invite.projectName}`}
                    >
                      <Text style={styles.declineButtonText}>Decline</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.inviteButton, styles.acceptButton]}
                      onPress={() => accept.mutate(invite._id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Accept invite to ${invite.projectName}`}
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
