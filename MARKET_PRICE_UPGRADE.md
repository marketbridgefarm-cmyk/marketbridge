# MarketBridge — Market Price & Post-Inspection Price Review Upgrade

This upgrade preserves the existing listing, negotiation, order, inspection,
transport and payment workflows. It adds evidence-based market references,
an absolute negotiation deadline, and auditable post-inspection price review.

## Behavior

- Initial listing offers keep their existing 24-hour response timer.
- Counteroffers keep their existing 12-hour response timer.
- New negotiation chains also receive a 48-hour absolute deadline by default,
  capped by an agricultural listing's pickupWindowEnd.
- The absolute deadline is configurable with OFFER_NEGOTIATION_DEADLINE_HOURS.
- Every new listing offer/counter snapshots the current market reference.
- Market references prefer recent completed MarketBridge transactions for the
  same category/unit/product identity; active comparable listings are a fallback.
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
   `202610050001_market_price_review_upgrade`.
5. Existing orders are backfilled so `originalFinalPrice = finalPrice`.

No new environment variable is required. `OFFER_NEGOTIATION_DEADLINE_HOURS`
is optional and defaults to 48.
