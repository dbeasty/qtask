import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ApiError, getAuthConfig } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { OAuthCancelledError } from '../auth/oauth';

const PROVIDER_LABEL: Record<string, string> = {
  google: 'Continue with Google',
  microsoft: 'Continue with Microsoft',
};

export function LoginScreen() {
  const { login, loginWithOAuthProvider, serverUrl, setServerUrl } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [oauthPending, setOauthPending] = useState<string | null>(null);

  const { data: authConfig } = useQuery({
    queryKey: ['auth-config', serverUrl],
    queryFn: getAuthConfig,
    retry: false,
  });

  const onSubmit = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  const onOAuthPress = async (providerId: string) => {
    setOauthPending(providerId);
    setError(null);
    try {
      await loginWithOAuthProvider(providerId);
    } catch (err) {
      if (!(err instanceof OAuthCancelledError)) {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
      }
    } finally {
      setOauthPending(null);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign in</Text>
      <Text style={styles.server}>{serverUrl}</Text>

      {authConfig?.oauthProviders?.map((provider) => (
        <TouchableOpacity
          key={provider.id}
          style={styles.oauthButton}
          disabled={oauthPending !== null}
          onPress={() => onOAuthPress(provider.id)}
        >
          {oauthPending === provider.id ? (
            <ActivityIndicator />
          ) : (
            <Text style={styles.oauthButtonText}>{PROVIDER_LABEL[provider.id] ?? provider.label}</Text>
          )}
        </TouchableOpacity>
      ))}

      {authConfig?.oauthProviders?.length ? (
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>
      ) : null}

      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity style={styles.button} onPress={onSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
      </TouchableOpacity>
      <TouchableOpacity onPress={() => setServerUrl('')} style={styles.link}>
        <Text style={styles.linkText}>Change server</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 4 },
  server: { fontSize: 12, color: '#888', marginBottom: 24 },
  oauthButton: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  oauthButtonText: { fontSize: 15, fontWeight: '600', color: '#111' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#eee' },
  dividerText: { marginHorizontal: 10, color: '#999', fontSize: 12 },
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
  link: { marginTop: 16, alignItems: 'center' },
  linkText: { color: '#2563eb', fontSize: 14 },
});
