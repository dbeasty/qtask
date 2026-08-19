import type { SearchHit } from '@qtask/shared';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { search } from '../api/client';

type ResultRow = SearchHit & { kind: 'project' | 'task' };

export function SearchScreen({ navigation }: any) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['search', submitted],
    queryFn: () => search(submitted),
    enabled: submitted.length > 0,
  });

  const rows: ResultRow[] = data
    ? [
        ...data.projects.map((p) => ({ ...p, kind: 'project' as const })),
        ...data.tasks.map((t) => ({ ...t, kind: 'task' as const })),
      ]
    : [];

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder="Search projects and tasks"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={() => setSubmitted(query.trim())}
        />
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{(error as Error).message}</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => `${item.kind}-${item.id}`}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            submitted ? (
              <View style={styles.center}>
                <Text style={styles.empty}>No results for "{submitted}".</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              onPress={() =>
                item.kind === 'project'
                  ? navigation.navigate('TaskList', { projectId: item.id, projectName: item.title })
                  : navigation.navigate('TaskDetail', { taskId: item.id })
              }
            >
              <Text style={styles.rowKind}>{item.kind === 'project' ? 'PROJECT' : 'TASK'}</Text>
              <Text style={styles.rowTitle}>{item.title}</Text>
              {item.snippet ? (
                <Text style={styles.rowSnippet} numberOfLines={2}>
                  {item.snippet}
                </Text>
              ) : null}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  searchRow: { padding: 16, paddingBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  list: { padding: 16, paddingTop: 8, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { color: '#c0392b' },
  empty: { color: '#888' },
  row: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#f5f5f7',
    borderRadius: 10,
    marginBottom: 8,
  },
  rowKind: { fontSize: 10, color: '#2563eb', fontWeight: '700', marginBottom: 2 },
  rowTitle: { fontSize: 16, fontWeight: '500' },
  rowSnippet: { fontSize: 12, color: '#888', marginTop: 4 },
});
