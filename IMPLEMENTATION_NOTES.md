# MarketBridge P0 Workflow Implementation

Replace the files in this bundle at the same paths in the GitHub repository.

Implemented:
- Server-authoritative agricultural inspection stage.
- Agricultural goods-payment gate when an inspection request exists and is not completed.
- Inspector actions exposed by the order workflow: start inspection and complete-report deep link.
- Requester inspection quote review action in the order Action Center.
- Direct execution of transporter pickup/in-transit/delivered actions from the Order Action Center.
- Direct execution of order cancellation and inspection start actions.
- Inspector report deep link with `inspectionId` so the report form opens automatically.
- Existing transport payment/PICKUP payment gate remains enforced server-side.

No Prisma schema migration is required for these changes.

After replacing the files:
1. Commit and push to GitHub.
2. Run backend tests/build and Prisma validation in CI/deployment.
3. Test the complete agricultural path: inspection request -> quote/accept -> inspector start -> report complete -> goods payment -> transport accept -> transport payment -> pickup -> in transit -> delivered -> buyer receipt.


## P1 implementation — payment obligations + order events (2026-09-13)

Implemented:
- Durable `PaymentObligation` records for marketplace, inspection and hired-transport obligations.
- `Payment` can link to exactly one obligation through `obligationId`.
- Idempotent obligation synchronisation for new/legacy orders.
- Durable customer-facing `OrderEvent` history separate from `AuditEvent`.
- Payment settlement updates the obligation and records an order event.
- Order creation, cancellation and receipt confirmation record domain events.
- Inspection acceptance/start/completion records domain events and refreshes obligations.
- Transport status changes record domain events and refresh hired-transport obligations.
- Workflow now exposes payer/beneficiary/obligation IDs and durable activity history.
- Frontend payment status now shows payer/recipient; order timeline renders durable activity.
- Migration backfills obligations and initial ORDER_CREATED events for existing orders.

Migration:
`backend/prisma/migrations/202609130003_payment_obligations_order_events/migration.sql`

Deployment:
`npx prisma migrate deploy` (the backend start script already runs this in production).
