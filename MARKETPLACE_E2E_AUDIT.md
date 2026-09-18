# MarketBridge Marketplace End-to-End Audit

## Canonical purchase contracts

### Agricultural
1. Publish agricultural listing.
2. Buyer offer / seller counter / buyer accepts.
3. Order is created with `paymentDueAt = null`.
4. Buyer/seller requests exactly one active order-owned inspection.
5. Inspector quote -> acceptance -> inspection payment -> inspection -> report.
6. Buyer `PATCH /orders/:id/buyer-decision` with `BUY` or `CANCEL`.
7. Only `BUY` unlocks marketplace payment and transport.
8. Marketplace payment settles -> order confirmed.
9. Transport agreement -> transport payment -> pickup evidence -> movement -> delivery -> receipt.

### Physical Product
1. Active `PRODUCT` listing.
2. Buyer `POST /orders/buy-now`.
3. Server atomically claims the listing and creates a pending order.
4. Buyer pays `MARKETPLACE`.
5. Payment settlement confirms the order.
6. Transport, if required, remains independent of the agricultural inspection/decision gate.

### Digital
1. Active private `DigitalProduct` with a secure `fileKey`.
2. Buyer creates/reuses a `DigitalPurchase` and a `DIGITAL` payment.
3. Chapa/payment provider settles the payment authoritatively.
4. Settlement changes the digital purchase to `COMPLETED`.
5. Download endpoint issues a short-lived signed URL only for a paid/completed purchase.
6. Failed/refunded/cancelled payment can be retried without violating the unique `(productId,buyerId)` purchase constraint.

## Important deployment requirement

The backend start command now runs `prisma generate` before `prisma migrate deploy`. This prevents a deployed application from using a stale Prisma client after schema changes such as `Order.buyerDecision` and `InspectionRequest.orderId`.

## Regression coverage

`backend/test/marketplace.e2e.test.js` is the authoritative disposable-PostgreSQL E2E suite. It verifies the agricultural decision gate and payment ordering. The workflow unit suite verifies that product/digital orders do not inherit the agricultural decision gate.
