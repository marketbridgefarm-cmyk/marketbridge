# Installment payments for large goods payments

Chapa rejects any single transaction above the merchant limit (1,000,000 ETB by
default; override with `CHAPA_MAX_TRANSACTION_AMOUNT`). A goods payment above the
limit is paid in equal installments, each within the limit.

## How it works
- Buyer sees the limit first, then chooses "Pay in N installments".
- `POST /api/payments` with `installments: true` creates the plan: the normal
  MARKETPLACE payment for the full price (the *parent*, never sent to Chapa) and
  N `MARKETPLACE_INSTALLMENT` payments (the *children*), each with its own
  Chapa checkout. All existing callback, webhook and verify code works on
  children unchanged.
- The parent settles PAID only when every installment is PAID. That single
  settlement confirms the order, commits inventory, writes the ledger and
  creates the seller payout hold. **The seller is paid nothing until all
  installments are in.**
- A failed installment is retried with `POST /api/payments/:id/retry-installment`.
- Cancelling the order (or a dispute that cancels it) refunds every paid
  installment individually; the parent becomes REFUNDED after the last one.
  Unpaid installments are closed.

## Deploy
1. Run the migration `202609280001_marketplace_installments` (`prisma migrate deploy`).
2. Redeploy backend (Render) and frontend (Vercel).
3. Tests: `node --test test/installments.test.js`.
