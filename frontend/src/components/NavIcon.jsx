import React from 'react';

// Shared inline-SVG icon set for the app shell (no external icon font, so the
// existing CSP is unaffected).
export default function NavIcon({ name, size = 20 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
  };

  const paths = {
    menu: <><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></>,
    home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-7h6v7"/></>,
    marketplace: <><path d="M4 9h16l-1-5H5L4 9Z"/><path d="M5 9v11h14V9"/><path d="M9 20v-7h6v7"/><path d="M4 9c0 1.7 1.1 3 2.5 3S9 10.7 9 9c0 1.7 1.1 3 2.5 3S14 10.7 14 9c0 1.7 1.1 3 2.5 3S19 10.7 19 9"/></>,
    negotiation: <><path d="M4 5h16v11H8l-4 4V5Z"/><path d="M8 9h8M8 12h5"/></>,
    orders: <><path d="M6 3h12v18H6z"/><path d="M9 7h6M9 11h6M9 15h4"/></>,
    transport: <><path d="M3 6h11v11H3z"/><path d="M14 10h4l3 3v4h-7z"/><circle cx="7" cy="19" r="2"/><circle cx="18" cy="19" r="2"/></>,
    inspection: <><path d="m9 11 2 2 4-4"/><path d="M20 12a8 8 0 1 1-4.7-7.3"/><path d="M20 4v5h-5"/></>,
    advertising: <><path d="m4 10 11-5v14L4 14z"/><path d="M15 9h3a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3h-3"/><path d="M7 15v5"/></>,
    payments: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/></>,
    notification: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    messages: <><path d="M21 6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4l3 3 3-3h4a2 2 0 0 0 2-2V6Z"/><path d="M7 9h10M7 13h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.65 1.65 0 0 0-1.8-.3 1.65 1.65 0 0 0-1 1.5v.2h-4v-.2a1.65 1.65 0 0 0-1-1.5 1.65 1.65 0 0 0-1.8.3l-.1.1-2.8-2.8.1-.1a1.65 1.65 0 0 0 .3-1.8 1.65 1.65 0 0 0-1.5-1H3v-4h.2a1.65 1.65 0 0 0 1.5-1 1.65 1.65 0 0 0-.3-1.8l-.1-.1 2.8-2.8.1.1a1.65 1.65 0 0 0 1.8.3 1.65 1.65 0 0 0 1-1.5V3h4v.2a1.65 1.65 0 0 0 1 1.5 1.65 1.65 0 0 0 1.8-.3l.1-.1 2.8 2.8-.1.1a1.65 1.65 0 0 0-.3 1.8 1.65 1.65 0 0 0 1.5 1h.2v4h-.2a1.65 1.65 0 0 0-1.5 1Z"/></>,
    account: <><circle cx="12" cy="8" r="3"/><path d="M5 21a7 7 0 0 1 14 0"/></>,
    chevron: <path d="m7 9 5 5 5-5"/>,
    login: <><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M14 5h5v14h-5"/></>,
    leaf: <><path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19c2-5 5-8 9-10"/></>,
    register: <><circle cx="12" cy="8" r="3"/><path d="M5 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/></>,
  };

  return <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
