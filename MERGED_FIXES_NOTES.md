# MarketBridge — merged, corrected set

Replaces packages 0–5. Apply this ONE set (copy over the project, then run
`npx prisma migrate deploy`). Do not apply the older packages on top of it.

## Merge fixes
- payments.js: contains BOTH the checkout seller-confirmation gate (pkg 2) and the goods-payment-before-transport rule (pkg 4).
- orderWorkflowService.js: pkg 4 transport/BUY sequence + seller-confirmation stage/actions/obligation payments. Fixed a ReferenceError in pkg 4 (`reportCompleted` undefined in buildActions).
- OrderDetail.jsx: obligation-based inspection payment UI + loading-report approval + transport-payment gating (pkg 5).
- Included from earlier packages: chapa.js, transport.js, orders.js, schema.prisma, buyer_loading_confirmation migration, Dashboard/ActionCenter/TransportLoadingReport/WorkflowActions.

## Audit items 1–6
1. Deadlines + closure (new services/inspectionLapseService.js, maintenanceService.js, inspections.js):
   - Provisional agreement (ACCEPTED) gets a seller-confirmation window (INSPECTION_SELLER_CONFIRM_HOURS, default 24h) stored in workflowDueAt.
   - After confirmation, a payment window (INSPECTION_PAYMENT_HOURS, default 24h).
   - On expiry or seller decline (new POST /inspections/:id/seller-decline): inspection cancelled, quotes expired, open obligations cancelled, coordination messages closed, provisional order cancelled (listing freed), buyer notified (OfferNotification type ORDER_CLOSED).
   - If any inspection money was paid, nothing is cancelled silently: partly-paid agreements move to STALLED; a payer mid-checkout is retried next cycle.
   - Release-to-REQUESTED paths restore the bidding window.
2. Inspector start clock (startDueAt) now begins only when the fee is fully paid (maintenance pass), not at seller confirmation.
3. seller-confirm now locks the order and rejects cancelled/completed/disputed orders and expired windows.
4. seller-message authorizes on order.sellerId (listing seller only for order-less requests).
5. Payment-intent creation: orderId taken from the inspection itself (cannot be omitted/swapped), inspection must be ACCEPTED and seller-confirmed, CANCELLED obligations rejected, closed orders rejected.

6. Stale inspection obligations (paymentObligationService.js): the sync now cancels any OPEN inspector obligation whose key is no longer wanted (fee payer changed, e.g. BUYER -> SPLIT, or the inspection request was cancelled). PAID obligations are never touched. Prevents a double charge.

## Migration
202610080001_inspection_agreement_deadlines: resets workflowDueAt on existing ACCEPTED rows so old REQUESTED-phase deadlines don't instantly cancel live agreements. Run before the new maintenance code starts.

## Tests
node --test test/agricultural.buyer-decision.workflow.test.js test/inspection.lapse.test.js test/payment.obligations.test.js → 17/17 pass.
Two old tests were rewritten to the pkg 4 sequence (BUY only after transporter + seller preparation).
Not run: full backend suite, routes against a database, frontend build (project dependencies and several utils files are not in the archive).
