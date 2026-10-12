// components/requestOptions.js — closed option lists for the request forms and
// messages. Mirrors utils/requestOptions.js on the server (which enforces them).
// No field built from these lists accepts typed text or numbers.

export const QUANTITY_VALUES = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const QUANTITY_UNITS = ['kg', 'tons', 'quintals', 'units', 'crates', 'bags'];

// FIXED: Strict sequence — every step is +1, no jumps.
// Must match utils/requestOptions.js on the backend exactly.
export const WEIGHT_OPTIONS = [
  '1 ton',
  '2 tons',
  '3 tons',
  '4 tons',
  '5 tons',
  '6 tons',
  '7 tons',
  '8 tons',
  '9 tons',
  '10 tons',
  '11 tons',
  '12 tons',
  '13 tons',
  '14 tons',
  '15 tons',
  '16 tons',
  '17 tons',
  '18 tons',
  '19 tons',
  '20 tons',
];

// FIXED: Strict sequence — every step is +1, no jumps.
// Must match utils/requestOptions.js on the backend exactly.
export const PACKAGE_COUNTS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
];

// FIXED: Strict sequence — every step is +1, no jumps.
// TransportSetup.jsx renders each as "{t} t or more".
// Must match utils/requestOptions.js on the backend exactly.
export const CAPACITY_TONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
];

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
