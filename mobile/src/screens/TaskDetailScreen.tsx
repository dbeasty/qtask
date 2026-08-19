import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { deleteTask, getTask, updateTask } from '../api/client';

const STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export function TaskDetailScreen({ route, navigation }: any) {
  const { taskId } = route.params;
  const queryClient = useQueryClient();

  const { data: task, isLoading } = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => getTask(taskId),
  });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? '');
    }
  }, [task]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['task', taskId] });
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };

  const save = useMutation({
    mutationFn: () => updateTask(taskId, { title: title.trim(), description }),
    onSuccess: invalidate,
  });

  const setStatus = useMutation({
    mutationFn: (status: (typeof STATUSES)[number]) => updateTask(taskId, { status }),
    onSuccess: invalidate,
  });

  const setPriority = useMutation({
    mutationFn: (priority: (typeof PRIORITIES)[number]) => updateTask(taskId, { priority }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: () => deleteTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      navigation.goBack();
    },
  });

  const onDelete = () => {
    Alert.alert('Delete task', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() },
    ]);
  };

  if (isLoading || !task) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.label}>Title</Text>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={setTitle}
        onBlur={() => title.trim() && title !== task.title && save.mutate()}
      />

      <Text style={styles.label}>Description</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={description}
        onChangeText={setDescription}
        onBlur={() => description !== (task.description ?? '') && save.mutate()}
        multiline
      />

      <Text style={styles.label}>Status</Text>
      <View style={styles.chipRow}>
        {STATUSES.map((s) => (
          <TouchableOpacity
            key={s}
            style={[styles.chip, task.status === s && styles.chipActive]}
            onPress={() => setStatus.mutate(s)}
          >
            <Text style={[styles.chipText, task.status === s && styles.chipTextActive]}>{s}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Priority</Text>
      <View style={styles.chipRow}>
        {PRIORITIES.map((p) => (
          <TouchableOpacity
            key={p}
            style={[styles.chip, task.priority === p && styles.chipActive]}
            onPress={() => setPriority.mutate(p)}
          >
            <Text style={[styles.chipText, task.priority === p && styles.chipTextActive]}>{p}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.deleteButton} onPress={onDelete}>
        <Text style={styles.deleteButtonText}>Delete task</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 12, color: '#888', marginTop: 16, marginBottom: 6, textTransform: 'uppercase' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  multiline: { minHeight: 90, textAlignVertical: 'top' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: '#f5f5f7',
  },
  chipActive: { backgroundColor: '#2563eb' },
  chipText: { color: '#333', fontSize: 13 },
  chipTextActive: { color: '#fff' },
  deleteButton: { marginTop: 32, alignItems: 'center', padding: 12 },
  deleteButtonText: { color: '#c0392b', fontWeight: '600' },
});
