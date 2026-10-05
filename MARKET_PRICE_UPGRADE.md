# MarketBridge — Market Price & Post-Inspection Price Review Upgrade

This upgrade preserves the existing listing, negotiation, order, inspection,
transport and payment workflows. It adds evidence-based market references,
a locked waiting list with notices, and auditable post-inspection price review.

## Behavior

- There is no absolute negotiation deadline: buyer and seller may negotiate
  back and forth until a price is agreed. Agricultural negotiations are still
  capped by the listing's pickupWindowEnd.
- Listing askingPrice (and minAcceptablePrice) are PER-UNIT prices. Market
  references are per unit and are never derived by dividing askingPrice by
  quantity.
- Every new listing offer/counter snapshots the current market reference.
- Market references prefer completed MarketBridge sales of the same
  category/unit/product from the last 60 days (same region first, then
  nationwide); other active listings are the fallback. At least 3 comparables
  are required. Otherwise no reference is shown ("not enough market data").
  A listing's own asking price is never used as its own market reference.
  Optional env: MARKET_REFERENCE_MIN_SAMPLES (default 3),
  MARKET_REFERENCE_WINDOW_DAYS (default 60).
- Negotiation flow (no timers, no limit on counters):
  - Many buyers bid; the seller selects ONE for exclusive negotiation. Other bids
    stay PENDING on the waiting list, and new bids keep joining it.
  - The seller can select, accept and counter. The seller can NOT reject or
    release anyone, and cannot touch the waiting list while a buyer is in
    negotiation or an order is unpaid (waiting list locked).
  - The selected buyer can counter or reject. After a rejection, or when the
    order is cancelled, the seller selects another waiting bid.
  - Waiting bidders can leave the list themselves (action WITHDRAW).
  - When goods are paid, all waiting bids are released (status WITHDRAWN,
    shown as "Released") and bidders are notified.
- Offer response timers (24h / 12h) are removed because they would expire
  waiting bids. The only limit left is an agricultural listing's pickupWindowEnd.
- Waiting-list notices (new table OfferNotification, migration
  202610050002_waiting_list_notices): bid selected, waiting list locked,
  waiting list unlocked, bids released. API: GET /api/offers/notices and
  PATCH /api/offers/notices/read. Shown on the Negotiations page.
- REQUIRED WIRING (payment code is not part of this package): in the place where
  a MARKETPLACE payment becomes PAID, call after the transaction commits:
    const { releaseWaitingBidders } = require('../services/waitingListService');
    await releaseWaitingBidders(prisma, { listingId: order.listingId, actorId, reason: 'LISTING_COMMITTED' });
- Order cancellation: orders.js sends the "unlocked" notice. Check
  services/orderCancellationService.js: if promoteNextWaitingBuyer there selects
  the next buyer automatically, remove that call so the seller always chooses.
- Market references never automatically change an offer, listing or order price.
- Accepted offer amounts remain the negotiated unit price; the order continues
  to calculate total payment as unit price × quantity.
- Orders now preserve originalFinalPrice even if a later accepted price review
  changes finalPrice.
- After a completed inspection report, MarketBridge calculates a non-binding
  suggested revised total using inspected quantity and the market reference.
- Quality/damage findings are recorded but are not converted into an arbitrary
  automatic discount percentage.
- A price review remains bilateral: ACCEPT, COUNTER or REJECT.
- Only acceptance changes Order.finalPrice; payment gates remain unchanged.

## Deployment

1. Replace/add the files in this package, preserving their paths.
2. Commit and push.
3. Deploy with the existing MarketBridge build/start configuration.
4. The existing Render/Railway Prisma migration flow will apply
   `202610050001_market_price_review_upgrade` and
   `202610050002_waiting_list_notices`.
5. Existing orders are backfilled so `originalFinalPrice = finalPrice`.

No new environment variable is required (the two market variables above are optional).

If an earlier version of this migration (with Offer.negotiationDeadlineAt) was
already applied, add a follow-up migration that drops that column and its index.
