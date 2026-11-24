import React from 'react';
import './Avatar.css';

// Shared avatar for every person in the app (profile card, seller, product cards …).
// Photo when `src` is given, otherwise a glossy initials badge whose colour is picked from the name,
// so the same person always gets the same colour. `verified` adds a check badge; `online` a green dot.
const TONES = ['green', 'terracotta', 'blue', 'gold', 'violet', 'teal'];

export function toneFor(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
}

export function initialsOf(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'U';
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return (first + last).toUpperCase();
}

export default function Avatar({ name, src, size = 'md', tone, verified = false, online = false, className = '' }) {
  const t = tone || toneFor(name || '');
  return (
    <span
      className={`mbav mbav--${size} mbav--${t}${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={name ? `${name}${verified ? ' (verified)' : ''}` : 'User'}
    >
      {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <span className="mbav-initials" aria-hidden="true">{initialsOf(name)}</span>}
      {online && <i className="mbav-dot" aria-hidden="true" />}
      {verified && (
        <i className="mbav-check" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="100%" height="100%"><path d="M5.5 10.5l3 3 6-6.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </i>
      )}
    </span>
  );
}

// Round verified tick used beside names (profile card, seller card).
export function VerifiedTick({ size = 20, label = 'Verified' }) {
  return (
    <svg className="mbav-tick" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
      <path d="M12 1.8l2.5 1.9 3.1-.3 1.2 2.9 2.8 1.4-.5 3.1 1.5 2.7-2 2.4-.1 3.1-3 .9-1.8 2.6L12 21.2l-2.7 1.3-1.8-2.6-3-.9-.1-3.1-2-2.4 1.5-2.7-.5-3.1 2.8-1.4 1.2-2.9 3.1.3L12 1.8z" fill="currentColor" />
      <path d="M8 12.3l2.8 2.8 5.2-5.6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
