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
2. Buyers submit competing offers; each buyer has one active root negotiation.
3. Seller selects one buyer for bilateral negotiation; only that selected thread may counter.
4. Negotiation acceptance creates one provisional `PENDING_PAYMENT` order; inventory is not committed yet.
5. Buyer requests an inspection; inspectors submit competing quotes.
6. Buyer selects one inspector, negotiates if needed, and pays the inspection fee. Payment commits the inspector.
7. Inspector completes a product-specific inspection report.
8. Buyer explicitly chooses `BUY` or `CANCEL`. `BUY` unlocks goods payment; `CANCEL` releases the provisional order and promotes the next waiting buyer.
9. Buyer pays `MARKETPLACE`; settlement commits product inventory.
10. Transport uses the same competitive quote/selection/negotiation/payment model.

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
