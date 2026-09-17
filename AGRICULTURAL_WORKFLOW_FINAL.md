# MarketBridge — Agricultural End-to-End Workflow Final Correction

Implemented against the requested lifecycle:

1. Seller publishes agricultural produce — listing ACTIVE.
2. Buyer submits offer — offer PENDING.
3. Buyer/seller negotiate with counter/accept until agreement.
4. Accepted offer creates an order and records the exact accepted offer + agreed time/price.
5. Inspection is requested from the order, not from the public listing.
6. Inspector quote negotiation: quote/counter/accept.
7. Inspection payment is required before the inspector can start.
8. Inspection is performed and report is published.
9. Buyer must explicitly choose BUY or CANCEL.
10. CANCEL ends the transaction.
11. BUY unlocks seller/goods payment.
12. Transport cannot be arranged until BUY, seller payment, and required inspection payments are complete.
13. Transport quote negotiation continues with counter/accept.
14. Accepted hired transport creates the transport payment obligation.
15. Pickup requires all required payments and pickup evidence.
16. Transporter controls pickup/in-transit/delivery movement.
17. Order synchronizes to IN_TRANSIT and DELIVERED.
18. Delivery requires delivery evidence.
19. Buyer confirms receipt to reach COMPLETED.

## Architectural corrections

- Added `InspectionRequest.orderId` and an `Order.inspectionRequests` relation. Existing inspection rows are backfilled where an active order can be identified; `orderId` remains nullable only for legacy pre-order inspection records.
- Added `Order.agreedOfferId` and `Order.agreedAt` and linked them to the exact accepted `Offer`.
- Agricultural offer acceptance no longer starts the generic unpaid-order expiry clock before inspection/buyer decision.
- BUY starts the normal payment deadline.
- Public listing pages no longer initiate transaction-specific inspections.
- Order Detail uses order-owned inspections.
- Payment obligations use order-owned inspections.
- Transport payment/pickup gates use order-owned inspections.
- Inspection start is blocked until the agreed inspection fee is paid.
- Buyer decision is blocked until an inspection exists and has a report.
- Seller payment is blocked until inspection report + BUY.
- Agricultural transport arrangement is blocked until BUY + seller payment + required inspection payment.
- Transport movement synchronizes order status.
- Order state machine permits `TRANSPORT_ARRANGED -> IN_TRANSIT` and prevents backward/skipped transitions.

## Validation

All 47 backend tests were executed. 39 passed, 6 were intentionally skipped because they require opt-in disposable PostgreSQL/E2E configuration, and 2 failed only because this extracted environment has no installed npm dependencies (`express-rate-limit` and `jsonwebtoken`). The modified workflow tests and order-state-machine tests all passed.
