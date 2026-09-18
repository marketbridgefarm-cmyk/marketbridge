# Agricultural Buyer Decision Gate

Implemented the next agricultural marketplace workflow gate after inspection.

## New sequence

1. Inspection request / negotiation
2. Inspection payment can occur before the report
3. Inspector completes and publishes the inspection report
4. Buyer explicitly chooses **BUY** or **CANCEL**
5. **BUY** unlocks seller/goods payment and transport arrangement
6. **CANCEL** records the decision and runs the normal order cancellation/refund workflow
7. Transport payment remains separate and is only created after an accepted transport agreement

## Backend enforcement

- Added nullable `Order.buyerDecision` and `Order.buyerDecisionAt`.
- Added `PATCH /orders/:id/buyer-decision`.
- Agricultural goods payment now requires `buyerDecision=BUY` and a completed inspection report when an inspection exists.
- Agricultural transport arrangement now requires `buyerDecision=BUY`.
- Buyer decision is concurrency-safe and recorded in `OrderEvent` as `BUYER_DECISION_MADE`.
- Added buyer-decision notification support.

## Frontend

- Order workflow now exposes BUY / CANCEL as the next step after the report.
- Seller payment remains visibly locked until BUY is selected.
- Existing inspection is shown instead of duplicate request controls.
- Payment center displays the buyer decision state.

## Validation

The new workflow unit tests pass with Node's built-in test runner. Full dependency installation/frontend build was not available in the execution environment.

## Regression corrections

- The buyer-decision mutation now re-validates the order, listing category, active inspection, and published report inside the same database transaction as the final conditional BUY/CANCEL write.
- Buyer-decision event/notification delivery is best-effort and cannot roll back the actual commercial decision.
- The frontend now sends an idempotency key for workflow mutations.
- ListingDetail no longer attempts to create a listing-only agricultural inspection; inspection requests are attached to the exact order.
- The end-to-end test now verifies that goods payment is rejected before BUY and that BUY occurs before goods settlement.
- Product Buy Now and Digital Purchase remain separate flows and do not use the agricultural buyer-decision gate.
