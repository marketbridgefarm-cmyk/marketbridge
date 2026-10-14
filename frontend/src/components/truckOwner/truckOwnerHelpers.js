// Constants and pure helpers for the transport-owner dashboard.
// Extracted verbatim from pages/TruckOwnerDashboard.jsx.

export const TABS = [
  { id: 'trucks', label: 'My Trucks' },
  { id: 'available', label: 'Available Jobs' },
  { id: 'jobs', label: 'My Jobs' },
];

export const EMPTY_TRUCK_FORM = {
  registration: '',
  truckType: '',
  capacity: '',
  operatingArea: '',
};

export const TERMINAL_STATUSES = ['DELIVERED', 'CANCELLED'];

/* ── Small presentational helpers (Orders-style card system) ── */

/* ── Small presentational helpers (Orders-style card system) ── */

export function initialsOf(name) {
  if (!name) return '??';
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase();
}

export function fmtDate(value) {
  return value ? new Date(value).toLocaleDateString() : null;
}

export function fmtMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : null;
}

// "ORD 25464DE7" style short reference, matching the Orders cards.
export function shortOrder(id) {
  if (!id) return null;
  return `ORD ${String(id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// The agreed price of a job: explicit field first, then the accepted quote
// (a counter-offer, when present, is the price that was actually accepted).
export function jobAmount(job) {
  const accepted = (job.quotes || []).find((q) => q.status === 'ACCEPTED');
  const raw =
    job.agreedAmount ??
    job.amount ??
    job.price ??
    accepted?.counterAmount ??
    accepted?.amount ??
    null;
  return raw == null ? null : fmtMoney(raw);
}

// Short label + initials for the "Arranged by" cluster in a card head.
export function arrangerShort(arrangingParty) {
  switch (arrangingParty) {
    case 'SELLER':
      return { name: 'Seller', initials: 'S' };
    case 'BUYER':
      return { name: 'Buyer', initials: 'B' };
    case 'JOINT':
      return { name: 'Buyer + Seller', initials: 'B+S' };
    default:
      return { name: 'Marketplace', initials: 'M' };
  }
}

// Tone (success | info | gold | danger | muted) for a transport job status.
export function jobTone(status) {
  switch (status) {
    case 'DELIVERED':
    case 'ACCEPTED':
      return 'success';
    case 'PICKUP':
    case 'IN_TRANSIT':
      return 'info';
    case 'CANCELLED':
      return 'danger';
    case 'REQUESTED':
    case 'QUOTED':
    case 'SELECTED':
      return 'gold';
    default:
      return 'muted';
  }
}

export function truckTone(availability) {
  if (availability === 'AVAILABLE') return 'success';
  if (availability === 'BUSY') return 'info';
  return 'muted';
}

export function verificationTone(status) {
  const s = String(status || '').toUpperCase();
  if (['VERIFIED', 'APPROVED'].includes(s)) return 'success';
  if (['REJECTED', 'SUSPENDED'].includes(s)) return 'danger';
  return 'gold';
}

/*
 * Four-step trip timeline:
 *   Accepted → Pickup → In transit → Delivered
 * The "current" step is the next thing that still has to happen.
 */
export function jobProgress(status) {
  const labels = ['Accepted', 'Pickup', 'In transit', 'Delivered'];
  const s = String(status || '').toUpperCase();

  let idx = 0;
  if (s === 'ACCEPTED') idx = 1;
  else if (s === 'PICKUP') idx = 2;
  else if (s === 'IN_TRANSIT') idx = 3;
  else if (s === 'DELIVERED') idx = 4;

  return labels.map((label, i) => ({
    label,
    cls: i < idx ? 'done' : i === idx ? 'current' : '',
  }));
}

const HANDLING_LABELS = {
  FRAGILE: 'Fragile',
  KEEP_COOL: 'Keep cool',
  KEEP_DRY: 'Keep dry',
  THIS_SIDE_UP: 'This side up',
  VENTILATED: 'Ventilated',
  COVERED: 'Covered load',
};

export function workDetailsSummary(workDetails) {
  if (!workDetails) return null;
  const parts = [
    workDetails.weight && `Weight: ${workDetails.weight}`,
    workDetails.packageCount && `Packages: ${workDetails.packageCount}`,
    workDetails.vehicleType && `Vehicle: ${workDetails.vehicleType}`,
    workDetails.loadingHelp && `Loading: ${workDetails.loadingHelp}`,
    workDetails.unloadingHelp && `Unloading: ${workDetails.unloadingHelp}`,
    workDetails.deliveryDeadline && `Deadline: ${new Date(workDetails.deliveryDeadline).toLocaleString()}`,
    ...(workDetails.handling || []).map((h) => HANDLING_LABELS[h] || h),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No additional structured requirements';
}


export function getArrangingPartyLabel(arrangingParty) {
  switch (arrangingParty) {
    case 'SELLER':
      return 'Seller arranging';
    case 'BUYER':
      return 'Buyer arranging';
    case 'JOINT':
      return 'Buyer + Seller';
    default:
      return 'Marketplace request';
  }
}

export function getStatusClass(status) {
  if (status === 'DELIVERED') return 'sd-badge';
  if (status === 'CANCELLED') return 'sd-badge sd-warn';
  if (status === 'IN_TRANSIT') return 'sd-badge sd-blue';

  return 'sd-badge sd-warn';
}

// A quote's negotiation thread is only "live" at its leaf: the row that
// no later counter-quote points back to as a parent.
export function leafTransportQuote(quotes) {
  const list = Array.isArray(quotes) ? quotes : [];
  const parentIds = new Set(list.map((q) => q.parentQuoteId).filter(Boolean));
  const leaves = list.filter((q) => !parentIds.has(q.id));
  return leaves.sort(
    (a, b) =>
      new Date(b.updatedAt || b.createdAt || 0) -
      new Date(a.updatedAt || a.createdAt || 0)
  )[0] || null;
}

export function isQuoteExpired(quote) {
  return Boolean(quote?.expiresAt && new Date(quote.expiresAt).getTime() <= Date.now());
}
