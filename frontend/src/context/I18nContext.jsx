import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import en from '../locales/en.json';
import am from '../locales/am.json';
import om from '../locales/om.json';

// Deliberately not a heavier library (react-i18next etc.) — this app only
// needs flat-key lookup + fallback, and keeping it dependency-free makes
// the partial-coverage/fallback behavior (see locales/README.md) easy to
// audit in one place.

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'am', label: 'አማርኛ (Amharic)' },
  { code: 'om', label: 'Afaan Oromoo' },
];

const DICTIONARIES = { en, am, om };
const STORAGE_KEY = 'mb_language';
const DEFAULT_LANGUAGE = 'en';

function resolve(language, key) {
  return (
    DICTIONARIES[language]?.[key] ??
    DICTIONARIES[DEFAULT_LANGUAGE]?.[key] ??
    key
  );
}

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [language, setLanguageState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return DICTIONARIES[stored] ? stored : DEFAULT_LANGUAGE;
    } catch {
      return DEFAULT_LANGUAGE;
    }
  });

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // setLanguage only ever updates local device state (localStorage) — it
  // does NOT call the backend, so it works for logged-out visitors and
  // never fails/blocks on a network request. A logged-in user's account
  // preference (User.preferredLanguage, which also drives SMS body
  // language) is set separately in AccountSecurity.jsx via
  // PATCH /auth/me/preferences; this hook can be pointed at that value by
  // whatever loads the user object, but the two are intentionally
  // decoupled rather than one silently overwriting the other on load.
  function setLanguage(next) {
    if (!DICTIONARIES[next]) return;
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage unavailable (private browsing, etc.) — language
      // choice just won't persist across reloads, which is fine.
    }
  }

  const value = useMemo(
    () => ({
      language,
      setLanguage,
      t: (key) => resolve(language, key),
    }),
    [language]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useTranslation must be used within an I18nProvider');
  return ctx;
}
