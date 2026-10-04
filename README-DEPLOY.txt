MarketBridge PriceReview Prisma fix

Root cause: the deployed order route includes Order.priceReviews, but the Prisma schema/client does not define that relation.

Files:
- backend/prisma/schema.prisma: adds Order.priceReviews, User.priceReviewsProposed, and the PriceReview model while preserving seller-confirmation schema changes.
- backend/prisma/migrations/202610040003_inspection_price_review/migration.sql: creates the PriceReview table and indexes.

Deploy:
1. Copy these files into the same paths in the repository.
2. Commit and push the schema and migration together.
3. Ensure backend package prestart runs `npx prisma migrate deploy` and build/deploy runs `npx prisma generate` (or regenerate Prisma Client as part of deployment).
4. Confirm the new migration is committed and appears in the deployed migrations folder. Then redeploy.

Do not manually mark the migration as applied unless you have verified the table and indexes already exist in the production database.
