import type { Task } from '@qtask/shared';
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
import { createTask, listTasks, updateTask } from '../api/client';

const STATUS_LABEL: Record<Task['status'], string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function TaskListScreen({ route, navigation }: any) {
  const { projectId, projectName } = route.params ?? {};
  const queryClient = useQueryClient();
  const [newTitle, setNewTitle] = useState('');

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['tasks', projectId ?? 'all'],
    queryFn: () => listTasks(projectId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId ?? 'all'] });
    // Completing/uncompleting a task changes the parent project's rollup
    // (percentComplete etc.), so the projects list must refetch too.
    queryClient.invalidateQueries({ queryKey: ['projects'] });
  };

  const toggleDone = useMutation({
    mutationFn: (task: Task) =>
      updateTask(task._id, { status: task.status === 'done' ? 'todo' : 'done' }),
    onSuccess: invalidate,
  });

  const createNew = useMutation({
    mutationFn: () =>
      createTask({ title: newTitle.trim(), projectId: projectId ?? undefined }),
    onSuccess: () => {
      setNewTitle('');
      invalidate();
    },
  });

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: projectName ?? 'All tasks' });
  }, [navigation, projectName]);

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
        keyExtractor={(item: Task) => item._id}
        onRefresh={refetch}
        refreshing={isRefetching}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.empty}>No tasks yet.</Text>
          </View>
        }
        renderItem={({ item }: { item: Task }) => (
          <TouchableOpacity
            style={styles.row}
            onPress={() => navigation.navigate('TaskDetail', { taskId: item._id })}
          >
            <TouchableOpacity
              style={[styles.checkbox, item.status === 'done' && styles.checkboxDone]}
              onPress={() => toggleDone.mutate(item)}
            />
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, item.status === 'done' && styles.rowTitleDone]}>
                {item.title}
              </Text>
              <Text style={styles.rowMeta}>{STATUS_LABEL[item.status]}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="New task title"
          value={newTitle}
          onChangeText={setNewTitle}
          onSubmitEditing={() => newTitle.trim() && createNew.mutate()}
        />
        <TouchableOpacity
          style={styles.addButton}
          disabled={!newTitle.trim() || createNew.isPending}
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
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#f5f5f7',
    borderRadius: 10,
    marginBottom: 8,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#2563eb',
    marginRight: 12,
  },
  checkboxDone: { backgroundColor: '#2563eb' },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: '500' },
  rowTitleDone: { textDecorationLine: 'line-through', color: '#999' },
  rowMeta: { fontSize: 12, color: '#888', marginTop: 2 },
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
