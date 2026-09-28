

## Automatic installment count

Installment count is calculated automatically from the order amount and the configured Chapa per-transaction limit. The system uses the fewest installments necessary, with every installment at or below the limit.

Examples with a 1,000,000 ETB limit:

- 2,100,000 ETB → 3 installments of 700,000 ETB
- 4,000,000 ETB → 4 installments of 1,000,000 ETB
- 4,500,000 ETB → 5 installments of 900,000 ETB
- 20,000,000 ETB → 20 installments of 1,000,000 ETB

Amounts are calculated in cents and any rounding remainder is distributed across the first installments, so the installment total always equals the order total exactly. There is no hard-coded 3-installment or 12-installment ceiling in the amount-splitting service.

The Chapa cap remains configurable with `CHAPA_MAX_TRANSACTION_AMOUNT`. If Chapa changes the merchant limit, update that environment variable and redeploy; existing plans keep their already-recorded installment count and amounts.
