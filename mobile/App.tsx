import NetInfo from '@react-native-community/netinfo';
import { NavigationContainer } from '@react-navigation/native';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/auth/AuthContext';
import { OfflineBanner } from './src/components/OfflineBanner';
import { linking } from './src/navigation/linking';
import { RootNavigator } from './src/navigation/RootNavigator';

WebBrowser.maybeCompleteAuthSession();

// Ties React Query's online/offline state to the device's actual network
// status, so queries automatically refetch on reconnect instead of only on
// their next interval/focus.
onlineManager.setEventListener((setOnline) => {
  return NetInfo.addEventListener((state) => {
    setOnline(state.isInternetReachable !== false);
  });
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

export default function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <OfflineBanner />
          <NavigationContainer linking={linking}>
            <RootNavigator />
          </NavigationContainer>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
