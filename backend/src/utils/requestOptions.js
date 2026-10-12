// utils/requestOptions.js — closed option lists for request forms and messages.
// Nothing here is free text: every value a requester, seller or bidder can send
// through these fields must be one of these entries, so contact details cannot
// be typed in. Keep in sync with components/requestOptions.js on the frontend.

const QUANTITY_VALUES = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
const QUANTITY_UNITS = ['kg', 'tons', 'quintals', 'units', 'crates', 'bags'];

// FIXED: Strict sequence — every step is +1, no jumps.
const WEIGHT_OPTIONS = [
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
const PACKAGE_COUNTS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
];

// FIXED: Strict sequence — every step is +1, no jumps.
// TransportSetup.jsx renders each as "{t} t or more".
const CAPACITY_TONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
];

const ACCESS_NOTES = [
  'Loading dock available',
  'Forklift available',
  'Loading help available',
  'Narrow road access',
  'Gate pass required',
  'Early morning pickup only',
];

const BID_MESSAGES = [
  'I can start within 24 hours.',
  'I am available this week.',
  'My fee covers the full scope described.',
  'Equipment and materials are included.',
  'I can adjust the schedule to suit you.',
];

const SELLER_INSPECTION_MESSAGES = [
  'I confirm the selected inspector and agreed fee.',
  'The produce is ready for inspection.',
  'Please coordinate the inspection time with the buyer.',
  'Please contact me before visiting.',
  'The produce is not ready yet; please wait.',
];

const SELLER_TRANSPORT_MESSAGES = [
  'The goods are ready for pickup. You may proceed after coordinating with the buyer.',
  'Please contact me before submitting the loading plan.',
  'The goods are not ready yet; please wait.',
  'Please coordinate the pickup time with the buyer.',
];

const MAX_DEADLINE_DAYS = 120;

// express-validator custom: empty is allowed (field optional), anything else must be a listed message.
function presetMessage(list) {
  return (value) => {
    if (value == null || value === '') return true;
    if (typeof value === 'string' && list.includes(value.trim())) return true;
    throw new Error('Choose one of the provided messages');
  };
}

// specialRequirements is stored as "A; B" — every part must be a listed access note.
function accessNotesOnly(value) {
  if (value == null || value === '') return true;
  if (typeof value !== 'string') throw new Error('Invalid requirements');
  const parts = value.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length > ACCESS_NOTES.length || !parts.every((p) => ACCESS_NOTES.includes(p))) {
    throw new Error('Choose requirements from the provided list');
  }
  return true;
}

function withinDeadlineRange(iso) {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  return t >= now - 60 * 60 * 1000 && t <= now + MAX_DEADLINE_DAYS * 24 * 60 * 60 * 1000;
}

module.exports = {
  QUANTITY_VALUES, QUANTITY_UNITS, WEIGHT_OPTIONS, PACKAGE_COUNTS, CAPACITY_TONS, ACCESS_NOTES,
  BID_MESSAGES, SELLER_INSPECTION_MESSAGES, SELLER_TRANSPORT_MESSAGES,
  presetMessage, accessNotesOnly, withinDeadlineRange,
};
