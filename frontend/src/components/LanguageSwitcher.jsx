import React from 'react';
import { LANGUAGES, useTranslation } from '../context/I18nContext.jsx';

export default function LanguageSwitcher({ className = '' }) {
  const { language, setLanguage } = useTranslation();

  return (
    <select
      className={`lang-switcher ${className}`.trim()}
      value={language}
      onChange={(e) => setLanguage(e.target.value)}
      aria-label="Language"
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>{l.label}</option>
      ))}
    </select>
  );
}
