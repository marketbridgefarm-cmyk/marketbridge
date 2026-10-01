# P1B — Transport State-Machine Protection

## Changes

- `HIRE_TRANSPORTER` can no longer be moved to `ACCEPTED` through `PATCH /transport/:id/status`.
- Hired transport remains `QUOTED` after quote acceptance; transport payment settlement is the commitment boundary.
- `PICKUP -> CANCELLED` is removed from the normal transition graph.
- `IN_TRANSIT -> CANCELLED` is removed from the normal transition graph.
- Hired transport cannot be cancelled by a normal participant while a TRANSPORT payment is `PENDING`, `PROCESSING`, or `PAID`.
- Existing `OWN_TRUCK` direct-acceptance behavior is preserved.

## Expected lifecycle

REQUESTED -> QUOTED -> accepted quote -> transport payment -> ACCEPTED -> PICKUP -> IN_TRANSIT -> DELIVERED

For a payment-backed hired transport, quote/payment identity remains locked by the P0 transport payment binding.

## Validation

`backend/src/routes/transport.js`, `payments.js`, and `paymentService.js` pass `node --check`.

No database migration is required for this P1B change.
