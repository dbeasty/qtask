import type { Project } from '@qtask/shared';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { listProjects } from '../api/client';

export function ProjectsScreen({ navigation }: any) {
  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{(error as Error).message}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={data ?? []}
      keyExtractor={(item: Project) => item._id}
      onRefresh={refetch}
      refreshing={isRefetching}
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.empty}>No projects yet.</Text>
        </View>
      }
      renderItem={({ item }: { item: Project }) => (
        <TouchableOpacity
          style={styles.row}
          onPress={() => navigation.navigate('TaskList', { projectId: item._id, projectName: item.name })}
        >
          <Text style={styles.rowTitle}>{item.name}</Text>
          <Text style={styles.rowMeta}>{Math.round(item.percentComplete)}% complete</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { color: '#c0392b' },
  empty: { color: '#888' },
  row: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: '#f5f5f7',
    borderRadius: 10,
    marginBottom: 10,
  },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowMeta: { fontSize: 12, color: '#888', marginTop: 4 },
});
