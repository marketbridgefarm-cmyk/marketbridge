# MarketBridge Phase 3B — Deals & Competition

This phase adds the missing two-stage commercial workflow:

1. Competition / sealed bids
2. Counterparty selection
3. Price-deal negotiation
4. Accept / Counter / Reject
5. Only acceptance creates the assignment/order where applicable

## Buyer ↔ Seller
- Multiple buyers can submit independent bids on the same listing.
- Seller sees the competing buyer bids.
- Seller selects one buyer bid for the deal stage.
- Selected buyer can accept the selected price or counter.
- Seller can accept, reject, or counter the selected deal.
- Seller can reject unselected competition bids.
- Accepting the deal creates the existing order through the existing order workflow.

## Buyer/Seller ↔ Inspector
- Multiple inspectors can submit bids for the same inspection request.
- Requester sees the competing bids.
- Requester selects one inspector bid for the deal stage.
- Requester and selected inspector then negotiate with Accept / Counter / Reject.
- Selection alone does not assign the inspector and does not trigger payment.

## Buyer/Seller ↔ Transporter
- Multiple transport providers can submit bids for the same transport job.
- Arranging party sees the competing bids.
- Arranging party selects one transporter bid for the deal stage.
- Arranging party and selected transporter then negotiate with Accept / Counter / Reject.
- Selection alone does not assign the truck and does not authorize transport payment.

## Data model
Added `SELECTED` to:
- OfferStatus
- InspectionQuoteStatus
- TransportQuoteStatus

Added migration:
`backend/prisma/migrations/202609250001_quote_competition_selection/migration.sql`

No Chapa/payment implementation, authentication, database relations, or existing order state-machine logic was replaced.
