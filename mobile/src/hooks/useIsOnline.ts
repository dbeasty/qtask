import NetInfo from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';

export function useIsOnline(): boolean {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    return NetInfo.addEventListener((state) => {
      // isInternetReachable can be null while NetInfo is still probing;
      // treat that as online rather than flashing the banner on every launch.
      setIsOnline(state.isInternetReachable !== false);
    });
  }, []);

  return isOnline;
}
