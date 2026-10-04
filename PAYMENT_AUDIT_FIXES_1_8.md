# MarketBridge — Payment Audit Fixes 1–8

Implemented in backend:

1. **Price × quantity** — offer/counter amounts remain per-unit; accepted orders calculate `finalPrice = unitPrice × quantity` server-side. Minimum acceptable price is checked per unit. Listing quantity is locked/revalidated at acceptance.
2. **Automatic refunds** — maintenance now submits `REQUESTED` refunds automatically, then the existing provider-verification sweep finalizes `PROCESSING` refunds.
3. **Inventory release on cancellation** — committed goods are restored even when cancellation follows `DISPUTED`/`TRANSPORT_ARRANGED`; cancelled transport/inspection quote states are closed and an occupied truck is released where appropriate.
4. **Payout release gating** — payouts cannot release from the payment-time timer alone. Seller/transporter payouts require receipt/completion; inspector payouts require completed inspection. The hold window is anchored no earlier than the completion point.
5. **Payment during dispute** — verified provider payment remains financially PAID, is ledgered, but business effects are withheld while the order is DISPUTED. Dispute resolution replays paid goods/transport/inspection effects.
6. **Payment after stock shortage** — inventory-commit failure after provider success is converted to `RECONCILIATION_REQUIRED` in a new transaction rather than rolling the payment back to an apparently unpaid state.
7. **Webhook/provider amount validation** — successful provider settlement requires a provider amount; missing/mismatched amounts become reconciliation. State-machine transition guards are applied to reconciliation updates.
8. **Retry after failed payment** — FAILED attempts release their payment-obligation FK and reopen the obligation, allowing a new payment attempt without the `obligationId` unique constraint blocking it.

No Prisma schema migration is required for these changes.

Validation performed:
- `node --check` passed for every modified JavaScript file.
- Full application tests were not executed because this uploaded project has no installed `node_modules` and no live database/provider environment.
