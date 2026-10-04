# Service-scoped payment and dispute changes

This patch keeps the existing order, quote, payment, evidence, and payout records. It changes only the gates that contradicted the approved workflow:

- An accepted inspector may record `IN_PROGRESS` as the verified start. A positive inspection fee becomes due after the start (`paymentDue` and `paymentTrigger` are included in the response). Report submission remains gated by the existing inspection state machine.
- Transport `PICKUP` records physical handover and still requires pickup evidence before `IN_TRANSIT`. For hired transport, the transport payment must be `PAID` before `IN_TRANSIT`; it is no longer required before pickup. The transport departure gate checks the transport obligation only, not unrelated marketplace or inspection obligations.
- Disputes whose `disputeType` identifies transport/truck/delivery freeze transporter payouts only; inspection disputes freeze inspector payouts only; seller/product/goods/marketplace disputes freeze seller payouts only. Unrecognized legacy dispute types preserve the prior order-wide payout hold for compatibility. The same scope is applied when resuming a dispute hold.
- Existing payout hold windows, audit events, payment records, and state transitions are retained.

## Compatibility and remaining integration boundary

The existing order dispute state machine still marks the order `DISPUTED` and pauses order proceedings until resolution. That global order-level behavior is intentionally not silently removed by this patch because it affects cancellation, refunds, receipt, and reconciliation. To make a service dispute fully independent at the order-state level, the schema/API needs an explicit dispute scope and service-specific action guards, with corresponding frontend handling and migration. Likewise, seller confirmation of inspector start and transporter pickup needs a first-class confirmation record/endpoint; the existing evidence endpoint is not a substitute for that authorization.

## Validation

Changed JavaScript files pass `node --check`. Run the full backend test suite and frontend build in the repository environment before deployment.
