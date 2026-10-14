'use strict';
 
// ============================================================================
// ORDER DETAIL — PURE HELPERS
// ============================================================================
//
// Plain functions with no React, no JSX, and no hooks. They can be imported
// from OrderDetail.jsx or from any component that was extracted from it.
//
// Extracted from OrderDetail.jsx to reduce that file's size and to give
// future extracted card components a shared home for these helpers.
// ============================================================================

export const pad2 = (n) => String(n).padStart(2, '0');

export const shortId = (id) => id?.slice(0, 8) || '—';

export const label = (value) => String(value || '').replace(/_/g, ' ');

export const money = (value, fraction = 2) =>
  Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: fraction,
  });

export const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export const getError = (error, fallback) =>
  error?.response?.data?.error || error?.response?.data?.message || error?.message || fallback;

export const statusTone = (status) => {
  const value = String(status || '').toUpperCase();
  if (['COMPLETED', 'DELIVERED', 'PAID', 'ACCEPTED', 'CONFIRMED'].includes(value)) return 'good';
  if (['CANCELLED', 'REJECTED', 'FAILED', 'DISPUTED'].includes(value)) return 'bad';
  if (['TRANSPORT_ARRANGED', 'ARRANGED', 'QUOTED'].includes(value)) return 'info';
  if (['PENDING', 'AWAITING_PAYMENT', 'IN_PROGRESS', 'PROCESSING'].includes(value)) return 'wait';
  return 'neutral';
};

export const initials = (name) =>
  String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase() || '?';

export const scrollToId = (id, delay = 0) => {
  const go = () => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('od-flash');
    void el.offsetWidth;
    el.classList.add('od-flash');
    window.setTimeout(() => el.classList.remove('od-flash'), 1800);
  };
  if (delay) window.setTimeout(go, delay);
  else go();
};

export const leafQuotes = (quotes) => {
  const list = Array.isArray(quotes) ? quotes : [];
  const parents = new Set(list.map((q) => q.parentQuoteId).filter(Boolean));
  return list.filter((q) => !parents.has(q.id));
};
