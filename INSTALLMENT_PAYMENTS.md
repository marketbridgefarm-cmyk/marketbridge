# Installment Payments & Seller Settlement

## Chapa transaction limit

Set the merchant/provider per-transaction cap in the backend environment:

```env
CHAPA_MAX_TRANSACTION_AMOUNT=1000000
```

The application defaults to `1000000` ETB when the variable is absent. Change this value only when your Chapa merchant account has a confirmed higher transaction limit.

The value is used both to:
- block a single Chapa checkout that is too large;
- calculate the number of installments for an eligible marketplace order;
- show the limit to the buyer in the order payment card.

For example, a `2,100,000 ETB` marketplace order with a `1,000,000 ETB` cap becomes:

- installment 1: `700,000 ETB`
- installment 2: `700,000 ETB`
- installment 3: `700,000 ETB`

## Seller settlement rule

The full-price `MARKETPLACE` payment is the installment **parent**. It is never sent to Chapa.

Each `MARKETPLACE_INSTALLMENT` child has its own Chapa checkout. Seller payout creation happens only when every live installment sequence is `PAID`.

Therefore, for a 2.1M ETB order:
1. first installment paid -> no seller payout;
2. second installment paid -> no seller payout;
3. third installment paid -> parent settles for 2.1M ETB, the order payment gate commits, and the seller payout hold is created for the full net amount.

The payout hold still follows the normal release/dispute process. This feature does not automatically transfer money to the seller's bank or mobile-money account.

## Failed installment retry

A `FAILED` installment is terminal. The buyer can use **Payment failed — try again**.

The old failed attempt is retained for audit history and loses its active installment sequence. A fresh `PENDING` installment is created for the same sequence and amount.

## Refunds

When an order is cancelled:
- every paid installment is refunded separately through Chapa;
- unpaid installments are closed;
- the parent plan is marked `REFUND_PENDING` when it had already settled;
- the parent becomes `REFUNDED` after the paid/refunding child installments are no longer outstanding.

This prevents the parent from being refunded a second time and keeps provider refunds tied to real Chapa transaction references.

## Admin operations

The admin dashboard now has an **Installments** tab showing:
- buyer and seller;
- full plan amount;
- paid/total installment progress;
- each live installment and its status;
- seller payout status and amount;
- order status.

This is read-only monitoring. Actual seller payout is still recorded through the existing payout operations flow after its hold is released.

## Deployment

1. Apply migration:
   `prisma migrate deploy`
2. Set `CHAPA_MAX_TRANSACTION_AMOUNT` in the backend/Render environment.
3. Confirm `CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET`, `APP_BASE_URL`, and `API_BASE_URL`.
4. Redeploy backend and frontend.
5. In Chapa test mode, run one complete large order before enabling real-money use.

## Minimum acceptance test

For a `2,100,000 ETB` order with a `1,000,000 ETB` cap:

- order page shows the transaction limit;
- buyer can create a 3-installment plan;
- installments are exactly 700,000 ETB each;
- after installment 1: `1 of 3` and no seller payout;
- after installment 2: `2 of 3` and no seller payout;
- after installment 3: parent is `PAID`, order is committed/confirmed, and one seller payout hold exists for the full seller net amount;
- a failed installment can be retried without reopening the failed payment;
- cancelling the order creates separate Chapa refund requests for each paid installment.
