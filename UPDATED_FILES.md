# MarketBridge advertising production update

Updated for the advertising hardening requested on 12 Sep 2026.

## Backend
- `backend/prisma/schema.prisma` — campaign lifecycle metadata, server quote, creative/destination fields, publication audit fields, analytics events.
- `backend/prisma/migrations/202609120001_advertising_system/migration.sql` — advertising schema migration.
- `backend/prisma/migrations/202609120002_advertising_default/migration.sql` — new campaign default status.
- `backend/src/utils/adPricing.js` — server-owned ETB/day pricing and duration calculation.
- `backend/src/routes/ads.js` — pricing API, secure creative upload, server-side pricing, campaign lifecycle, moderation, Telegram publication, analytics, signed creative URLs, safe URLs, rate limiting.
- `backend/src/routes/payments.js` — advertising payments must exactly match the server quote and rejected/expired campaigns cannot be paid.
- `backend/src/services/paymentService.js` — paid advertising campaigns now transition correctly; Banner and Telegram require review.
- `backend/src/routes/listings.js` — deterministic paid-placement scoring and sponsored impression identifiers.
- `backend/src/routes/admin.js` — active-ad overview count updated for the new lifecycle.
- `backend/ADVERTISING_PRODUCTION.md` — deployment/security/lifecycle notes.

## Frontend
- `frontend/src/pages/AdvertiserDashboard.jsx` — capability available to every signed-in user, server pricing, payment lifecycle, creative preview, rejection state and analytics.
- `frontend/src/pages/AdminDashboard.jsx` — paid creative review, approval/rejection reason, financials, analytics, end-early and Telegram publication controls.
- `frontend/src/components/AdvertisementBanner.jsx` — public moderated banner serving plus impression/click tracking.
- `frontend/src/components/ListingCard.jsx` — sponsored listing impression tracking.
- `frontend/src/pages/Home.jsx` — public banner placement.
- `frontend/src/App.jsx` — advertising center no longer requires a permanent ADVERTISER role.
- `frontend/src/components/Navbar.jsx` — Promote / Advertise access for every signed-in user.
- `frontend/src/pages/Register.jsx` — removes ADVERTISER as a required optional role; advertising is now a platform capability.
- `frontend/src/styles.css` — banner presentation styles.

## Important deployment step
Run the Prisma migrations before or during deployment:

`npx prisma migrate deploy`

The existing Render/Railway start script already runs `prisma migrate deploy` before starting the API.

## Environment variables
Optional pricing overrides:
- `AD_RATE_FEATURED_LISTING`
- `AD_RATE_TOP_OF_CATEGORY`
- `AD_RATE_SPONSORED_SEARCH`
- `AD_RATE_BANNER`
- `AD_RATE_TELEGRAM_PROMOTION`
- `AD_MAX_CAMPAIGN_DAYS`
- `AD_BANNER_MAX_FILE_BYTES`

Object storage must already be configured because banner creative uses the same private S3-compatible storage pattern as other MarketBridge media.
