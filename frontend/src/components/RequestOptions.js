// components/requestOptions.js — closed option lists for the request forms and
// messages. Mirrors utils/requestOptions.js on the server (which enforces them).
// No field built from these lists accepts typed text or numbers.

export const QUANTITY_VALUES = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const QUANTITY_UNITS = ['kg', 'tons', 'quintals', 'units', 'crates', 'bags'];
export const WEIGHT_OPTIONS = ['100 kg', '250 kg', '500 kg', '1000 kg', '2 tons', '5 tons', '10 tons', '20 tons'];
export const PACKAGE_COUNTS = [1, 5, 10, 20, 50, 100, 200, 500];
export const CAPACITY_TONS = [1, 2, 3, 5, 8, 10, 15, 20];

export const ACCESS_NOTES = [
  'Loading dock available',
  'Forklift available',
  'Loading help available',
  'Narrow road access',
  'Gate pass required',
  'Early morning pickup only',
];

export const BID_MESSAGES = [
  'I can start within 24 hours.',
  'I am available this week.',
  'My fee covers the full scope described.',
  'Equipment and materials are included.',
  'I can adjust the schedule to suit you.',
];

export const DEADLINE_WINDOWS = [
  { key: '24h', label: 'Within 24 hours', hours: 24 },
  { key: '48h', label: 'Within 2 days', hours: 48 },
  { key: '3d', label: 'Within 3 days', hours: 72 },
  { key: '7d', label: 'Within 1 week', hours: 168 },
  { key: '14d', label: 'Within 2 weeks', hours: 336 },
  { key: '30d', label: 'Within 1 month', hours: 720 },
];

export function deadlineFromWindow(key) {
  const w = DEADLINE_WINDOWS.find((x) => x.key === key);
  return w ? new Date(Date.now() + w.hours * 60 * 60 * 1000).toISOString() : '';
}
