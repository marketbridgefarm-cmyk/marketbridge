# Advertising production recheck — updated files

- backend/prisma/schema.prisma
- backend/prisma/migrations/202609030001_advertising_default/migration.sql
- backend/prisma/migrations/202609030001_advertising_system/migration.sql
- backend/src/routes/ads.js
- backend/src/routes/listings.js
- backend/src/services/paymentService.js
- backend/src/utils/adPricing.js
- backend/src/utils/objectStorage.js
- frontend/src/pages/AdvertiserDashboard.jsx
- frontend/src/pages/AdminDashboard.jsx
- frontend/src/components/AdvertisementBanner.jsx

The key deployment fix is the two-stage AdStatus migration sequence. `ads.js` also verifies that an uploaded banner key belongs to the authenticated advertiser and exists in private object storage before campaign creation.
