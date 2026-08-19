import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsOnline } from '../hooks/useIsOnline';

export function OfflineBanner() {
  const isOnline = useIsOnline();
  const insets = useSafeAreaInsets();

  if (isOnline) return null;

  return (
    <View
      style={[styles.banner, { paddingTop: insets.top + 8 }]}
      accessibilityRole="alert"
      accessibilityLabel="You're offline. Showing the last data QTask loaded."
    >
      <Text style={styles.text}>You're offline — showing the last data loaded</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#b45309',
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  text: { color: '#fff', fontSize: 13, textAlign: 'center', fontWeight: '600' },
});
