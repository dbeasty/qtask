import type { LinkingOptions } from '@react-navigation/native';
import * as Linking from 'expo-linking';

// Lets a notification tap (or any external qtask://... link) open the right
// screen instead of just foregrounding the app on whatever tab was last
// active. `qtask://oauth?...` (the sign-in callback, see src/auth/oauth.ts)
// doesn't match any path below, so React Navigation just ignores it there —
// that URL is already consumed by WebBrowser.openAuthSessionAsync before
// this ever sees it.
export const linking: LinkingOptions<ReactNavigation.RootParamList> = {
  prefixes: [Linking.createURL('/'), 'qtask://'],
  config: {
    screens: {
      ProjectsTab: {
        screens: {
          ProjectsList: 'projects',
          ProjectDetail: 'project/:projectId',
          TaskList: 'projects/:projectId/tasks',
          TaskDetail: 'task/:taskId',
        },
      },
      SearchTab: 'search',
      NotificationsTab: 'notifications',
    },
  },
};
