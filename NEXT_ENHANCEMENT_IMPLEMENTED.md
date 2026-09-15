# MarketBridge — Next Enhancement: Payment State Machine & Provider Adapter Layer

Implemented the next production-hardening increment from the evaluation roadmap.

## Included

- Explicit payment lifecycle:
  - `PENDING -> PROCESSING -> PAID`
  - controlled `FAILED`
  - `RECONCILIATION_REQUIRED`
  - `PAID -> REFUND_PENDING -> REFUNDED`
  - failed refunds return `REFUND_PENDING -> PAID`
- Provider settlement is no longer allowed to skip the normal payment lifecycle.
- Hosted checkout claims a payment intent atomically before contacting a provider, preventing duplicate concurrent checkout initialization.
- Failed provider initialization releases the intent back to `PENDING` for retry.
- Provider adapter boundary added so Telebirr/Chapa, CBE, and future providers do not need to be embedded in route code.
- Chapa-backed Telebirr/QR initialization continues to use the existing verified Chapa implementation.
- Direct CBE integration is deliberately marked unconfigured until approved CBE API credentials/contract are supplied; no undocumented API behavior is invented.
- Refund requests now enter `REFUND_PENDING` and only a successful refund completion can reach `REFUNDED`.
- Advertisement cancellation no longer silently fabricates a completed refund for an already-paid payment; it creates the durable refund request.
- Unit tests added for valid and invalid payment transitions.

## Validation

`node --check` passed for all modified JavaScript files and the new state-machine tests passed.

A dependency-backed Prisma validation/integration run was not possible in this extracted workspace because Prisma CLI/node_modules are not installed. Run `npm install`/CI, then `npx prisma validate` and the PostgreSQL integration suite before deployment.
