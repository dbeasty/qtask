import type { Project } from '@qtask/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { createProject, listProjects } from '../api/client';

export function ProjectsScreen({ navigation }: any) {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  const createNew = useMutation({
    mutationFn: () => createProject({ name: newName.trim() }),
    onSuccess: () => {
      setNewName('');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
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
    <View style={styles.container}>
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
          <View style={styles.row}>
            <TouchableOpacity
              style={styles.rowMain}
              onPress={() => navigation.navigate('TaskList', { projectId: item._id, projectName: item.name })}
            >
              <Text style={styles.rowTitle}>{item.name}</Text>
              <Text style={styles.rowMeta}>{Math.round(item.percentComplete)}% complete</Text>
            </TouchableOpacity>
            {item.canEdit ? (
              <TouchableOpacity
                style={styles.editButton}
                onPress={() => navigation.navigate('ProjectDetail', { projectId: item._id })}
              >
                <Text style={styles.editButtonText}>Edit</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
      />
      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="New project name"
          value={newName}
          onChangeText={setNewName}
          onSubmitEditing={() => newName.trim() && createNew.mutate()}
        />
        <TouchableOpacity
          style={styles.addButton}
          disabled={!newName.trim() || createNew.isPending}
          onPress={() => createNew.mutate()}
        >
          <Text style={styles.addButtonText}>Add</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  list: { padding: 16, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { color: '#c0392b' },
  empty: { color: '#888' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f5f5f7',
    borderRadius: 10,
    marginBottom: 10,
  },
  rowMain: { flex: 1, paddingVertical: 14, paddingHorizontal: 16 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowMeta: { fontSize: 12, color: '#888', marginTop: 4 },
  editButton: { paddingHorizontal: 16, paddingVertical: 14 },
  editButtonText: { color: '#2563eb', fontSize: 13, fontWeight: '600' },
  addRow: {
    flexDirection: 'row',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    gap: 8,
  },
  addInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  addButton: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  addButtonText: { color: '#fff', fontWeight: '600' },
});
