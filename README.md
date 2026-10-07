# MarketBridge — Next Price Authority Fix

Fixes the post-inspection price-review boundary and closes a private-price leakage in offer errors.

- Below-minimum offer errors no longer disclose the seller's numeric minimum.
- Inspection-driven price proposals and counters are server-validated against the seller's minimum total price (minimum unit price × order quantity).
- Price-review UI labels the amount as a total price, distinguishing it from the listing's per-unit offer price.

Replacement files:
- backend/src/routes/offers.js
- backend/src/routes/orders.js
- frontend/src/components/OrderDecisionPanel.jsx
