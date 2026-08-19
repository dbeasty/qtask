import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { deleteProject, listProjects, updateProject } from '../api/client';

export function ProjectDetailScreen({ route, navigation }: any) {
  const { projectId } = route.params;
  const queryClient = useQueryClient();

  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });
  const project = projects?.find((p) => p._id === projectId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description ?? '');
    }
  }, [project]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['projects'] });

  const save = useMutation({
    mutationFn: () => updateProject(projectId, { name: name.trim(), description }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: () => {
      invalidate();
      navigation.goBack();
    },
  });

  const onDelete = () => {
    Alert.alert('Delete project', 'This deletes the project and unlinks its tasks. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() },
    ]);
  };

  if (isLoading || !project) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.label}>Name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        onBlur={() => name.trim() && name !== project.name && save.mutate()}
      />

      <Text style={styles.label}>Description</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={description}
        onChangeText={setDescription}
        onBlur={() => description !== (project.description ?? '') && save.mutate()}
        multiline
      />

      {project.canDeleteProjects ? (
        <TouchableOpacity
          style={styles.deleteButton}
          onPress={onDelete}
          accessibilityRole="button"
          accessibilityLabel="Delete project"
        >
          <Text style={styles.deleteButtonText}>Delete project</Text>
        </TouchableOpacity>
      ) : null}
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
  deleteButton: { marginTop: 32, alignItems: 'center', padding: 12 },
  deleteButtonText: { color: '#c0392b', fontWeight: '600' },
});
