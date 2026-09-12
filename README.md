# MarketBridge Advertising Production Recheck

This package is based on the newly uploaded production repository and contains only advertising-related production files that were rechecked/corrected.

## Critical Render migration repair

The Render database reported Prisma error P3009 because migration `202609030001_advertising_default` failed.

The corrected migration sequence is deliberately split:

1. `202609030001_advertising_default` adds the new `AdStatus` enum values only.
2. Prisma commits that migration.
3. `202609030001_advertising_system` creates/updates the advertising columns, event type/table, indexes, and only then sets the `Advertisement.status` default to `PENDING_PAYMENT`.

This avoids PostgreSQL's restriction on using a newly-added enum value before its transaction commits.

### One-time production repair

Run against the SAME production Railway PostgreSQL database used by Render, from `backend/`:

```bash
npx prisma migrate resolve --rolled-back 202609030001_advertising_default
npx prisma migrate deploy
```

Then restart/redeploy Render.

Do not delete or edit `_prisma_migrations` manually.

## Render startup

Keep:

```bash
prisma migrate deploy && node src/index.js
```

## Required storage configuration

Banner upload requires the existing S3-compatible private object storage configuration:

- `S3_REGION`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- optional `S3_ENDPOINT`
- optional `S3_FORCE_PATH_STYLE`

## Validation

Node syntax checks were run successfully for the advertising/payment/listing backend files. Prisma CLI execution was not available in the source-only inspection environment because dependencies were not installed locally; Render's `npm install`/Prisma generation should perform the final Prisma validation during deployment.
