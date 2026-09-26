# Provisional Winner / Waiting Buyer Workflow

## Commercial rule

A selected or negotiated buyer is a **provisional winner**, not the final buyer. The listing remains public and competing buyer offers remain in the waiting pool until the goods payment is successfully settled.

### Buyer lifecycle

1. Multiple buyers submit offers.
2. Seller selects one offer for negotiation.
3. Seller/buyer negotiation is accepted.
4. The selected buyer becomes the provisional winner and a `PENDING_PAYMENT` order is created.
5. For agricultural goods, inspection and the explicit buyer `BUY` decision happen before goods payment.
6. Inventory is committed only when the `MARKETPLACE` goods payment settles.
7. If the provisional buyer cancels (for example after an unfavorable inspection report), the order is cancelled without restoring inventory that was never committed, the listing stays public, and the highest-ranked waiting `PENDING` offer is promoted to `SELECTED`.
8. When goods payment settles, inventory is committed atomically. If the listing quantity is exhausted, remaining competing offers are closed.

## Why this matters

- A failed inspection does not make the seller lose public visibility.
- Waiting buyers are not rejected merely because another buyer temporarily won negotiation.
- `ACCEPTED` negotiation does not mean the goods are sold.
- Payment is the commercial commitment point.
- The same principle is used for physical `PRODUCT` listings; `DIGITAL` products do not use physical inventory/transport.

## Important implementation boundary

`backend/src/services/inventoryService.js` exposes `commitListingQuantity()`. It is called from payment settlement for physical goods. `reserveListingQuantity()` is retained for backward compatibility but is no longer used by offer acceptance.

## Cancellation promotion

`backend/src/services/orderCancellationService.js` promotes the next waiting buyer after a `PENDING_PAYMENT` provisional order is cancelled. Ranking is highest offer amount first, then earliest offer creation time as the tie-breaker.
