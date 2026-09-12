-- The advertising_default migration (202609030001) backfilled every AdStatus
-- value that PATCH /ads/:id/cancel and the schema needed except CANCELLED,
-- so cancelling a campaign fails in production with:
--   invalid input value for enum "AdStatus": "CANCELLED"
-- This adds the missing value. As with the other AdStatus backfills, the
-- value must be committed in its own migration before any later migration
-- or application query can reference it.
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
