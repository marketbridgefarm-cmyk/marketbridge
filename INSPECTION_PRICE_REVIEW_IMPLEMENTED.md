# Inspection-driven price review — focused patch

## Included files
- `backend/prisma/schema.prisma`: adds immutable `PriceReview` proposal history and relations.
- `backend/prisma/migrations/202610040003_inspection_price_review/migration.sql`: creates the table, foreign keys, indexes, and a partial unique index allowing only one pending proposal per order.
- `backend/src/routes/orders.js`: adds authenticated create/respond endpoints and prevents the ordinary BUY decision from bypassing an open price review. Only the other party may accept, counter, or reject. A counter creates a new history row. Acceptance updates the agreed order price and opens the existing payment gate.
- `frontend/src/pages/OrderDetail.jsx`: displays price review status/history and controlled amount/reason options after the inspection report.

## API
- `POST /api/orders/:id/price-reviews` — `{ "proposedPrice": 1234, "reasonCode": "QUALITY_OR_QUANTITY_CHANGE" }`
- `PATCH /api/orders/:id/price-reviews/:reviewId/respond` — `{ "action": "ACCEPT" }`, `{ "action": "REJECT" }`, or `{ "action": "COUNTER", "proposedPrice": 1200, "reasonCode": "FRESHNESS_OR_DAMAGE" }`

Reason codes: `MARKET_PRICE_RISE`, `MARKET_PRICE_FALL`, `QUALITY_OR_QUANTITY_CHANGE`, `FRESHNESS_OR_DAMAGE`, `OTHER_INSPECTION_FINDING`.

## Rules
- A completed inspection report is required before price review.
- Either buyer or seller can initiate; only the other party can respond.
- One pending proposal per order; counter-proposals create an immutable child row.
- A proposal must be accepted by the other party before `Order.finalPrice` changes.
- Acceptance records the buyer's BUY decision and resets the existing payment deadline; it does not itself mark the order paid/completed.
- Price review is blocked after goods payment has started, after BUY is already confirmed, or for cancelled/disputed/completed orders.
- Inspection fees remain separate from the goods price.

## Validation status
- `node --check backend/src/routes/orders.js` passed.
- Frontend build and Prisma validation could not be run in this environment because project dependencies were not installed; `npm ci` did not complete before the environment timeout. Run the deployment's normal Prisma migration and frontend build checks before production rollout.
