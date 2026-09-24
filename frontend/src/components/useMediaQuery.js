import { useEffect, useState } from 'react';

// Tiny matchMedia hook used by the app shell to choose between the desktop
// rail, tablet icon rail and mobile top/bottom bars. Safe when matchMedia is
// unavailable (tests / very old browsers): it simply reports "no match".
export default function useMediaQuery(query) {
  const read = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;

  const [matches, setMatches] = useState(read);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [query]);

  return matches;
}
