// utils/requestOptions.js — closed option lists for request forms and messages.
// Nothing here is free text: every value a requester, seller or bidder can send
// through these fields must be one of these entries, so contact details cannot
// be typed in. Keep in sync with components/requestOptions.js on the frontend.

const QUANTITY_VALUES = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
const QUANTITY_UNITS = ['kg', 'tons', 'quintals', 'units', 'crates', 'bags'];

const WEIGHT_OPTIONS = ['100 kg', '250 kg', '500 kg', '1000 kg', '2 tons', '5 tons', '10 tons', '20 tons'];
const PACKAGE_COUNTS = [1, 5, 10, 20, 50, 100, 200, 500];
const CAPACITY_TONS = [1, 2, 3, 5, 8, 10, 15, 20];

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
