import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { LoginScreen } from '../screens/LoginScreen';
import { ProjectsScreen } from '../screens/ProjectsScreen';
import { ServerSetupScreen } from '../screens/ServerSetupScreen';
import { TaskDetailScreen } from '../screens/TaskDetailScreen';
import { TaskListScreen } from '../screens/TaskListScreen';

export type RootStackParamList = {
  Projects: undefined;
  TaskList: { projectId?: string; projectName?: string };
  TaskDetail: { taskId: string };
};

const Stack = createNativeStackNavigator();

export function RootNavigator() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (status === 'needs-server') {
    return (
      <Stack.Navigator>
        <Stack.Screen name="ServerSetup" component={ServerSetupScreen} options={{ headerShown: false }} />
      </Stack.Navigator>
    );
  }

  if (status === 'needs-login') {
    return (
      <Stack.Navigator>
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      </Stack.Navigator>
    );
  }

  return (
    <Stack.Navigator>
      <Stack.Screen name="Projects" component={ProjectsScreen} options={{ title: 'Projects' }} />
      <Stack.Screen name="TaskList" component={TaskListScreen} />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ title: 'Task' }} />
    </Stack.Navigator>
  );
}
