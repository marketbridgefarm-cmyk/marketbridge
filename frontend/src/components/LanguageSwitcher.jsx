import React from 'react';
import { LANGUAGES, useTranslation } from '../context/I18nContext.jsx';

// Short labels for the compact segmented toggle (design freeze: EN / አማ / OM).
const SHORT_LABELS = { en: 'EN', am: 'አማ', om: 'OM' };

export default function LanguageSwitcher({ className = '', variant = 'select' }) {
  const { language, setLanguage } = useTranslation();

  if (variant === 'segmented') {
    return (
      <div className={`lang-segmented ${className}`.trim()} role="group" aria-label="Language">
        {LANGUAGES.map((l) => (
          <button
            key={l.code}
            type="button"
            className={`lang-segmented-btn${language === l.code ? ' active' : ''}`}
            aria-pressed={language === l.code}
            aria-label={l.label}
            onClick={() => setLanguage(l.code)}
          >
            {SHORT_LABELS[l.code] || l.code.toUpperCase()}
          </button>
        ))}
      </div>
    );
  }

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
