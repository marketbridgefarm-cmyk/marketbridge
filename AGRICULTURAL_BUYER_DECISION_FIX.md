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
