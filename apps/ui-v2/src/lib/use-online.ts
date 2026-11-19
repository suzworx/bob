import { useEffect, useState } from 'react';

// Whether the browser believes it is online. It starts from navigator.onLine
// and follows the window's `online` and `offline` events, so a surface can say
// it is offline and hold a send back instead of letting it fail. A reader who
// goes offline keeps what they typed: nothing here remounts anything.
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    // An event that fired between the first render and this effect is missed,
    // so read the flag once more now the listeners are in place.
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
