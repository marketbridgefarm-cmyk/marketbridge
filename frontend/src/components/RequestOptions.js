// components/requestOptions.js — closed option lists for the request forms and
// messages. Mirrors utils/requestOptions.js on the server (which enforces them).
// No field built from these lists accepts typed text or numbers.

export const QUANTITY_VALUES = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const QUANTITY_UNITS = ['kg', 'tons', 'quintals', 'units', 'crates', 'bags'];

// FIXED: Option B — strict +1 from 1 to 20, then +5 up to 150.
// Must match utils/requestOptions.js on the backend exactly.
export const WEIGHT_OPTIONS = [
  '1 ton',
  '2 tons', '3 tons', '4 tons', '5 tons', '6 tons', '7 tons', '8 tons', '9 tons', '10 tons',
  '11 tons', '12 tons', '13 tons', '14 tons', '15 tons', '16 tons', '17 tons', '18 tons', '19 tons', '20 tons',
  '25 tons', '30 tons', '35 tons', '40 tons', '45 tons', '50 tons',
  '55 tons', '60 tons', '65 tons', '70 tons', '75 tons', '80 tons',
  '85 tons', '90 tons', '95 tons', '100 tons', '105 tons', '110 tons',
  '115 tons', '120 tons', '125 tons', '130 tons', '135 tons', '140 tons',
  '145 tons', '150 tons',
];

// FIXED: Option B — strict +1 from 1 to 20, then +5 up to 150.
// Must match utils/requestOptions.js on the backend exactly.
export const PACKAGE_COUNTS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  25, 30, 35, 40, 45, 50, 55, 60, 65, 70,
  75, 80, 85, 90, 95, 100, 105, 110, 115, 120,
  125, 130, 135, 140, 145, 150,
];

// FIXED: Option B — strict +1 from 1 to 20, then +5 up to 150.
// TransportSetup.jsx renders each as "{t} t or more".
// Must match utils/requestOptions.js on the backend exactly.
export const CAPACITY_TONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  25, 30, 35, 40, 45, 50, 55, 60, 65, 70,
  75, 80, 85, 90, 95, 100, 105, 110, 115, 120,
  125, 130, 135, 140, 145, 150,
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
