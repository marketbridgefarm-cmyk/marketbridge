# MarketBridge — Inspection Strategy Upgrade

## Business rule

An accepted goods offer creates a **provisional order**, not an unconditional purchase. Goods payment remains locked until the buyer has the required inspection result and makes the final BUY decision.

The inspection fee pays for the independent verification service. It is **not** a purchase commitment and is not automatically refunded merely because the buyer decides not to buy after seeing the report.

### Fee responsibility

- `BUYER_REQUESTED` → buyer pays.
- `SELLER_REQUESTED` → seller pays.
- `JOINT` → 50/50 split by default.
- The payer is recorded on durable `PaymentObligation` rows, so buyer and seller can pay their own shares independently.

### Inspection applicability

- Agricultural listings are inspection-required by default and existing agricultural listings are migrated to `inspectionRequired=true`.
- Product listings are inspection-optional by default.
- If a product has no inspection requirement and neither party requests one, it can proceed through the normal negotiated purchase/payment flow.
- If a product inspection is explicitly requested, the inspection becomes the gate for that provisional order.
- Digital listings remain outside the inspection workflow.

## Inspection lifecycle

`REQUESTED → ACCEPTED → IN_PROGRESS → COMPLETED`

A workflow can become `STALLED` when:

- an assigned inspector does not start within the configured start window; or
- an in-progress inspector does not complete the report within the configured completion window.

Stalled inspections are not silently cancelled. Buyer/seller can request admin recovery; admin can release a fresh inspection competition when no inspection payment has started.

Defaults:

- bidding/request window: 48h
- assigned inspector start window: 24h
- report completion window: 24h

All are configurable through environment variables.

## Payment rule

The inspector **cannot start** until the agreed inspection fee is fully paid. For a split fee, both payment obligations must be paid.

This fixes the previous mismatch where the UI said payment was required before start but the backend could still allow `/inspections/:id/start` without a settled fee.

## Report integrity

Completed inspection reports are immutable. There is no normal report-edit operation.

If a factual correction is required, the inspector creates an `InspectionReportAddendum`, preserving:

- reason
- correction notes
- optional photos/videos
- optional GPS
- creator
- timestamp

The original report remains unchanged.

## Structured findings

The report now records:

- verified quantity
- quantity variance percentage against the listing quantity
- grade/condition
- moisture where applicable
- visible defects
- damage
- packaging
- inspector assessment summary
- structured quality flags
- evidence

These findings **do not create an automatic discount**.

## Post-inspection price review

After a completed report, the buyer or seller can propose a revised total price.

Market reference data is used only to calculate an **advisory suggestion**:

`market median unit price × inspected quantity = suggested revised total`

The platform never silently changes the buyer's or seller's price. The parties must explicitly ACCEPT, COUNTER, or REJECT the proposal.

The original negotiated order total is preserved in `Order.originalFinalPrice` for auditability.

## Market-price reference

Recent completed MarketBridge transactions are preferred. Active comparable listings are only a fallback.

The market reference is displayed as informational context and is **never used to determine the selectable offer/bid amount**. The buyer's offer picker remains anchored to the seller's asking price.
