# MarketBridge automated tests

## Fast tests

```bash
npm test
```

The marketplace E2E suite is intentionally skipped unless it is explicitly
opted in.

## Full marketplace E2E test

Use a **dedicated disposable PostgreSQL database**. Never use production.

```bash
export MARKETBRIDGE_E2E=1
export E2E_DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/marketbridge_e2e'
npx prisma migrate deploy
npm test
```

The E2E scenario exercises:

1. Seller creates an agricultural listing.
2. Buyer makes an offer.
3. Seller counters.
4. Buyer accepts the counter and an order is created.
5. Buyer requests an inspection.
6. Inspector quotes.
7. Buyer accepts the inspection quote.
8. Inspector starts and completes the inspection.
9. Marketplace and inspection payments are settled through `paymentService`.
10. Buyer creates hired transport.
11. Transporter submits a quote.
12. Buyer accepts the transport quote.
13. Transport payment is settled.
14. Transport pickup evidence is added.
15. Transport moves to PICKUP → IN_TRANSIT.
16. Delivery evidence is added.
17. Transport moves to DELIVERED.
18. Buyer confirms receipt.
19. The order reaches COMPLETED.
20. Durable order events are verified.

Security/regression checks in the same flow verify that:

- public listing responses do not expose `minAcceptablePrice`, offers, orders, or raw media keys;
- an unrelated user cannot view an order workflow;
- a buyer cannot falsely mark transport as DELIVERED;
- payment and evidence gates are enforced before physical movement;
- the final receipt action completes the order only after delivery and required payments.

## Notification integration

Step 4 adds durable in-app notifications generated transactionally from
`OrderEvent`. The same opt-in E2E database setup now also verifies that an
order event creates an actionable notification for the other order participant.

Notification endpoints:

```text
GET   /api/notifications
GET   /api/notifications/unread-count
PATCH /api/notifications/:id/read
POST  /api/notifications/read-all
```

Notifications are stored in PostgreSQL and are polled by the frontend every
30 seconds while a user is signed in. Clicking a notification marks it read
and opens the related order.


## Persistent refresh-session security tests

The refresh-session tests are opt-in and require a disposable PostgreSQL database with the latest migrations applied:

```bash
MARKETBRIDGE_AUTH_SESSION_TEST=1 DATABASE_URL="postgresql://..." npm test -- --test-name-pattern="refresh-session"
```

They verify persistent session creation, refresh-token rotation, replay/reuse invalidation, logout-all, and immediate access-token invalidation after logout.
