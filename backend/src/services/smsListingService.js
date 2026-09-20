'use strict';

// ============================================================================
// SMS LISTING SERVICE
// ============================================================================
//
// MarketBridge already sends SMS notifications (see smsService.js /
// SmsOutboxEntry) but has never accepted SMS *in* — every listing has to be
// created through the web app, which is a real barrier for a farmer with a
// basic phone and no reliable data connection. This adds a minimal inbound
// command grammar so a registered seller can create (and later activate) a
// listing purely by text message.
//
// Commands (case-insensitive, whitespace-tolerant):
//
//   LIST <cropType> <quantity> <unit> <pricePerUnit> <location...>
//     e.g. "LIST WHEAT 500 KG 25 Debre Zeit"
//     Creates a DRAFT AGRICULTURAL listing for the sending phone number's
//     account. Left as DRAFT rather than immediately ACTIVE — an SMS command
//     has no photo upload and much more room for a mistyped number, and
//     what's actually punished by a wrong "live" listing is the farmer, not
//     MarketBridge, so the safer default is "saved, needs one more step to
//     go live."
//
//   ACTIVATE <code>
//     Publishes a DRAFT listing created via SMS (or otherwise) that belongs
//     to this phone number, identified by the last 6 characters of its id
//     (sent back in the confirmation SMS after LIST).
//
// Deliberately NOT supported yet: editing an existing listing's price/
// quantity by SMS, or any command that touches money. Both are reasonable
// next steps but need more careful abuse/validation thought than fits here.
// ============================================================================

const prisma = require('../config/db');
const { normalizeEthiopianPhone } = require('./smsService');

const SHORT_CODE_LENGTH = 6;

function shortCode(listingId) {
  return listingId.slice(-SHORT_CODE_LENGTH).toUpperCase();
}

/**
 * Find the user a phone number belongs to. Phone numbers in the User table
 * are free-text (however the person typed them at signup), so this
 * compares on the same normalized Ethiopian E.164 form normalizeEthiopianPhone
 * already uses for outbound SMS, rather than requiring an exact string
 * match against however the DB happens to have it stored.
 *
 * MVP-scale note: this scans all users with a phone on file rather than
 * matching in SQL. Fine at MarketBridge's current user count; if this ever
 * shows up in a slow-query report, the fix is a generated/normalized phone
 * column with a real index, not a smarter scan.
 */
async function findUserByPhone(normalizedPhone) {
  const candidates = await prisma.user.findMany({
    where: { phone: { not: null } },
    select: { id: true, name: true, phone: true, roles: true },
    take: 10000,
  });
  return candidates.find((u) => normalizeEthiopianPhone(u.phone) === normalizedPhone) || null;
}

function parseListCommand(tokens) {
  // tokens: ["WHEAT", "500", "KG", "25", "Debre", "Zeit"]
  if (tokens.length < 5) {
    return { error: 'LIST needs: crop, quantity, unit, price per unit, and a location. Example: LIST WHEAT 500 KG 25 Debre Zeit' };
  }

  const [cropType, quantityRaw, unit, priceRaw, ...locationParts] = tokens;
  const quantity = Number(quantityRaw);
  const askingPrice = Number(priceRaw);
  const location = locationParts.join(' ').trim();

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { error: `"${quantityRaw}" is not a valid quantity` };
  }
  if (!Number.isFinite(askingPrice) || askingPrice <= 0) {
    return { error: `"${priceRaw}" is not a valid price` };
  }
  if (!location) {
    return { error: 'A location is required, e.g. LIST WHEAT 500 KG 25 Debre Zeit' };
  }

  return { cropType: cropType.toUpperCase(), quantity, unit: unit.toUpperCase(), askingPrice, location };
}

async function handleListCommand(user, tokens) {
  if (!user.roles.includes('SELLER')) {
    return { reply: 'Your MarketBridge account is not registered as a seller, so this number cannot list produce.' };
  }

  const parsed = parseListCommand(tokens);
  if (parsed.error) return { reply: `Could not create listing: ${parsed.error}` };

  const listing = await prisma.listing.create({
    data: {
      sellerId: user.id,
      category: 'AGRICULTURAL',
      cropType: parsed.cropType,
      quantity: parsed.quantity,
      availableQuantity: parsed.quantity,
      unit: parsed.unit,
      askingPrice: parsed.askingPrice,
      location: parsed.location,
      status: 'DRAFT',
      description: 'Created via SMS',
    },
  });

  const code = shortCode(listing.id);
  return {
    reply: `Draft listing saved: ${parsed.quantity}${parsed.unit} ${parsed.cropType} at ${parsed.askingPrice}/${parsed.unit} in ${parsed.location}. Reply ACTIVATE ${code} to publish it, or edit it in the app first.`,
    listing,
  };
}

async function handleActivateCommand(user, tokens) {
  const code = (tokens[0] || '').toUpperCase();
  if (!code) return { reply: 'ACTIVATE needs a code, e.g. ACTIVATE 3F9A21' };

  const candidates = await prisma.listing.findMany({
    where: { sellerId: user.id, status: 'DRAFT', category: 'AGRICULTURAL' },
    select: { id: true, cropType: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const match = candidates.find((c) => shortCode(c.id) === code);
  if (!match) {
    return { reply: `No draft listing found with code ${code}. It may already be published, or belong to a different account.` };
  }

  await prisma.listing.update({ where: { id: match.id }, data: { status: 'ACTIVE' } });
  return { reply: `Listing ${code} (${match.cropType || 'produce'}) is now live on MarketBridge.` };
}

/**
 * Entry point for the inbound SMS webhook route. Never throws for a
 * malformed or unrecognized message — always resolves to a reply string
 * (or null if there is truly no one to reply to, i.e. the phone number
 * itself failed to normalize) so the route can always send something back
 * instead of the sender getting silence.
 */
async function handleInboundSms({ from, text }) {
  const normalizedPhone = normalizeEthiopianPhone(from);
  if (!normalizedPhone) return { reply: null, reason: 'invalid_from_number' };

  const body = String(text || '').trim();
  const tokens = body.split(/\s+/).filter(Boolean);
  const command = (tokens[0] || '').toUpperCase();

  const user = await findUserByPhone(normalizedPhone);
  if (!user) {
    return { reply: 'This number is not registered on MarketBridge. Sign up in the app first, then text from this number.', to: normalizedPhone };
  }

  if (command === 'LIST') {
    const result = await handleListCommand(user, tokens.slice(1));
    return { ...result, to: normalizedPhone };
  }

  if (command === 'ACTIVATE') {
    const result = await handleActivateCommand(user, tokens.slice(1));
    return { ...result, to: normalizedPhone };
  }

  return {
    reply: 'Unrecognized command. Text LIST <crop> <quantity> <unit> <price> <location> to create a draft listing, or ACTIVATE <code> to publish one.',
    to: normalizedPhone,
  };
}

module.exports = { handleInboundSms, parseListCommand, shortCode };
