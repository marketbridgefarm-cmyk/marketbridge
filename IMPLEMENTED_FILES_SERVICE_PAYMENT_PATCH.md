# Changed files

- `backend/src/routes/inspections.js` — inspection start is the fee trigger; response reports payment due.
- `backend/src/routes/transport.js` — pickup may precede transport payment; transport payment gates `IN_TRANSIT`; transport gate is service-specific.
- `backend/src/services/payoutService.js` — dispute payout holds/resumption scoped by dispute type and payee role.
- `backend/src/routes/disputes.js` — passes dispute type into payout hold/resume service.
- `SERVICE_SCOPED_PAYOUT_AND_PAYMENT_TRIGGERS.md` — implementation behavior and compatibility boundary.
