import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { pingServer } from '../api/client';
import { useAuth } from '../auth/AuthContext';

// QTask is self-hosted, so unlike the web app (always same-origin) the
// mobile app must be told which server to talk to on first launch.
export function ServerSetupScreen() {
  const { setServerUrl, serverUrl } = useAuth();
  const [url, setUrl] = useState(serverUrl ?? 'https://qtask.dev');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const onContinue = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError('Enter your QTask server URL');
      return;
    }
    const normalized = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    setChecking(true);
    setError(null);
    const reachable = await pingServer(normalized);
    setChecking(false);
    if (!reachable) {
      setError('Could not reach that server. Check the URL and try again.');
      return;
    }
    await setServerUrl(normalized);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Connect to QTask</Text>
      <Text style={styles.subtitle}>
        QTask is self-hosted. Enter the address of your QTask server (e.g.
        https://qtask.example.com).
      </Text>
      <TextInput
        style={styles.input}
        placeholder="https://qtask.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={url}
        onChangeText={setUrl}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity style={styles.button} onPress={onContinue} disabled={checking}>
        {checking ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Continue</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#555', marginBottom: 24 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 12,
  },
  error: { color: '#c0392b', marginBottom: 12 },
  button: { backgroundColor: '#2563eb', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
