-- Must return zero rows before applying the P1 partial-sale index.
SELECT "listingId", COUNT(*) AS live_order_count
FROM "Order"
WHERE "status" NOT IN ('CANCELLED', 'COMPLETED')
GROUP BY "listingId"
HAVING COUNT(*) > 1;
