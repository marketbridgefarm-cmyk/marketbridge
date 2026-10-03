'use strict';

// ============================================================================
// CONTACT GUARD + AMOUNT GUARD
// ============================================================================
// Keeps deals on-platform:
//   • findContactInfo(text)  – detects phone numbers, emails, links, chat-app
//                              handles and "call me" style phrases.
//   • amountProblem(value)   – rejects amounts that are out of range or have
//                              more than 2 decimals (phone numbers smuggled
//                              into price fields look like huge/odd numbers).
// Both are pure functions so they can be unit-tested without a database.
// ============================================================================

const CONTACT_MESSAGE =
  'For your protection, keep contact details off MarketBridge. Phone numbers, ' +
  'emails, links and chat-app handles are not allowed - negotiate and message here.';

// Upper limits (ETB). Every Ethiopian mobile number is 9+ digits, so any limit
// below 100,000,000 also stops a phone number being used as a price.
const AMOUNT_LIMITS = {
  offer: 50000000,
  inspection: 1000000,
  transport: 5000000,
};

// ---- text normalisation ---------------------------------------------------

function toAsciiDigits(text) {
  return String(text)
    .normalize('NFKC') // full-width digits -> ascii
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660)) // Arabic-Indic
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0)) // Persian
    .replace(/[\u1369-\u1371]/g, (c) => String(c.charCodeAt(0) - 0x1368)); // Ge'ez 1-9
}

// ---- detectors ------------------------------------------------------------

// 9+ digits in a row, allowing up to two separator characters between digits
// ("0911 22 33 44", "+251-911-223344", "(0911)223344").
const DIGIT_RUN = /(?:\d[\s().\-_*/\\|]{0,2}){9,}/;

const DIGIT_WORDS = '(?:zero|one|two|three|four|five|six|seven|eight|nine)';
const SPELLED_RUN = new RegExp(`(?:\\b${DIGIT_WORDS}\\b[\\s,.\\-]*){7,}`, 'i');

const EMAIL = /[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[a-z0-9-]+(?:\s*(?:\.|\(dot\)|\[dot\])\s*[a-z0-9-]+)+/i;

const LINK =
  /(?:https?:\/\/|www\.|\b(?:t\.me|wa\.me|bit\.ly|tinyurl\.com)\/|\b[a-z0-9-]+\.(?:com|net|org|info|biz|et|io|me|co|app|link|gl|ly)\b)/i;

const HANDLE = /(?:^|[^\w@])@[a-z0-9_.]{3,}/i;

const APP_NAMES = /\b(?:telegram|whatsapp|whats\s?app|viber|wechat|messenger|instagram|facebook|tiktok)\b/i;

// English + Amharic (ስልክ phone, ቴሌግራም telegram, ዋትስአፕ whatsapp) + Oromo (bilbila phone).
const CONTACT_PHRASES =
  /(?:\b(?:my|your)\s+(?:phone|mobile|cell|number|contact)\b|\bphone\s*(?:number|no)\b|\bcall\s+me\b|\btext\s+me\b|\bdm\s+me\b|\boff[\s-]?(?:the\s+)?(?:platform|app|site)\b|\boutside\s+(?:the\s+)?(?:platform|app|site)\b|\bbilbila\b|ስልክ|ቴሌግራም|ዋትስአፕ)/i;

/**
 * Returns the kind of contact info found ('phone' | 'email' | 'link' |
 * 'handle' | 'app' | 'phrase') or null when the text is clean.
 */
function findContactInfo(text) {
  if (text === undefined || text === null) return null;
  const raw = String(text);
  if (!raw.trim()) return null;

  const t = toAsciiDigits(raw);

  if (DIGIT_RUN.test(t)) return 'phone';
  if (SPELLED_RUN.test(t)) return 'phone';
  if (EMAIL.test(t)) return 'email';
  if (LINK.test(t)) return 'link';
  if (HANDLE.test(t)) return 'handle';
  if (APP_NAMES.test(t)) return 'app';
  if (CONTACT_PHRASES.test(t)) return 'phrase';
  return null;
}

/** express-validator custom() validator: throws when contact info is present. */
function noContactInfo(value, { req } = {}) {
  const kind = findContactInfo(value);
  if (kind) {
    if (req && req.log && typeof req.log.warn === 'function') {
      req.log.warn(
        { userId: req.user && req.user.id, kind, path: req.originalUrl },
        'CONTACT_INFO_BLOCKED'
      );
    }
    throw new Error(CONTACT_MESSAGE);
  }
  return true;
}

// ---- amounts --------------------------------------------------------------

/**
 * Returns an error string, or null when the amount is acceptable.
 * Only used on NEW input (never on stored values).
 */
function amountProblem(value, max) {
  if (value === undefined || value === null || value === '') {
    return 'Amount is required';
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 'Amount must be greater than zero';
  if (n > max) {
    return `Amount cannot be more than ${max.toLocaleString('en-US')} ETB`;
  }
  // at most 2 decimals
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    return 'Amount can have at most 2 decimal places';
  }
  return null;
}

/** express-validator custom() validator built on amountProblem. */
function validAmount(max) {
  return (value) => {
    const problem = amountProblem(value, max);
    if (problem) throw new Error(problem);
    return true;
  };
}

module.exports = {
  CONTACT_MESSAGE,
  AMOUNT_LIMITS,
  findContactInfo,
  noContactInfo,
  amountProblem,
  validAmount,
};
