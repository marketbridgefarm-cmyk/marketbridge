# Fixes from screenshots
1. backend/src/routes/recoveryRequests.js — "Approve fresh service form" returned a Prisma error
   (`Argument truckOwnerId must not be null`). The previous transporter had already withdrawn, so
   TransportJob.truckOwnerId was null, and it was used as a filter on TransportQuote.updateMany
   (TransportQuote.truckOwnerId is non-nullable). The expiry now only runs when an owner is assigned.
2. frontend/src/pages/order-details/OrderDetail.css — transport quote cards had different widths and
   centred content because the global `.transporter` rule's `align-items:center` leaked into the
   column layout. Now `align-items: stretch`, left-aligned.
