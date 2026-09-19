# Telegram promotions — Photo Carousel template

Advertisers can now pick **Photo Carousel** as a Telegram promotion template and
upload many photos (2–10) that MarketBridge staff post as one swipeable
Telegram album, with the advertiser's message as the caption.

## Behaviour

- New selectable template `CAROUSEL` alongside Classic / Hot Deal / Fresh Harvest / …
- Photos can be selected many at once (or added in batches), reordered
  (← / →) and removed before submitting. Slide order = order posted.
- Live swipeable preview while building; the same carousel appears on the
  advertiser's campaign card and in the admin review card / campaign ledger
  (with an "Open photo N full size" link for staff posting by hand).
- Price is unchanged: every Telegram template costs the same flat daily rate.

## Rules (enforced server-side)

- 2–10 photos (Telegram albums hold 2–10). `AD_TELEGRAM_CAROUSEL_MAX_IMAGES`
  can lower the max, never raise it above 10.
- JPEG / PNG / WebP, `AD_BANNER_MAX_FILE_BYTES` per file (default 5 MB).
- Files are validated by signature, EXIF-stripped, resized (default 1600 px,
  `AD_TELEGRAM_IMAGE_MAX_DIMENSION`) and re-encoded as **JPEG**
  (`AD_TELEGRAM_IMAGE_QUALITY`) — the format the Telegram Bot API handles most reliably.
- Stored privately under `advertisements/telegram/<userId>/<uuid>.jpg`.
  Campaign creation only accepts keys under the caller's own prefix, with no
  duplicates, so nobody can attach another user's or an arbitrary bucket file.
- Images sent with any other template/type are ignored.
- Raw storage keys are never returned on reads; the API returns short-lived
  signed `telegramImageUrls`. The public `GET /ads/active` feed omits them.

## API

- `POST /api/ads/telegram-images` (auth, multipart, field `files`, up to 10) →
  `201 { images: [{ key, previewUrl, width, height, bytes, ... }] }`
- `POST /api/ads` accepts `telegramTemplate: "CAROUSEL"` and
  `telegramImageKeys: [key, ...]` (ordered).
- `GET /api/ads/pricing` now includes `telegramCarousel: { minImages, maxImages, maxFileBytes }`.
- `GET /api/ads/mine` and admin `GET /api/ads` include `telegramImageUrls` and `telegramImageCount`.

## Deployment

1. `npx prisma migrate deploy` — applies `202609190001_add_telegram_carousel`
   (adds enum value `CAROUSEL` and `Advertisement.telegramImageKeys TEXT[]`;
   existing campaigns are untouched).
2. Optional env vars are listed in `backend/.env. example`.
3. `npm run docs:generate` refreshes `openapi/openapi.json` (also runs on `render:build`).

## Files

New: `frontend/src/components/ImageCarousel.jsx`, `backend/src/utils/telegramCarousel.js`,
`backend/prisma/migrations/202609190001_add_telegram_carousel/`, `backend/test/telegramCarousel.test.js`.

Changed: `backend/prisma/schema.prisma`, `backend/src/routes/ads.js`,
`backend/src/utils/adPricing.js`, `backend/src/utils/imageProcessor.js`
(optional `format: 'jpeg'`), `backend/test/adPricing.test.js`,
`backend/test/advertising.e2e.test.js`, `backend/.env. example`,
`frontend/src/pages/AdvertiserDashboard.jsx`, `frontend/src/pages/AdminDashboard.jsx`,
`frontend/src/styles.css`.

## Related security fixes (same change set)

- **`POST /api/growth/telegram-promo` is now ADMIN-only.** It posts to the public
  MarketBridge Telegram channel with the platform bot token but previously only
  required a signed-in user, so anyone could broadcast arbitrary text/links.
  (`backend/src/routes/growth.js`, test: `backend/test/growth.telegram-promo.test.js`.)
- **Banner creative keys are now verified on campaign creation.** `POST /api/ads`
  only accepts a `creativeImageKey` under the caller's own
  `advertisements/banner/<userId>/` prefix, and both banner and carousel keys must
  exist in private object storage (a storage outage is a 5xx, not "image missing").
  This makes the behaviour described in `UPDATED_FILES.md` real.
  (`backend/src/routes/ads.js`, `backend/src/utils/adCreativeKeys.js`, tests:
  `backend/test/adCreativeKeys.test.js`, `backend/test/advertising.e2e.test.js`.)

Not changed: `telegram-promo`'s optional `campaignId` still flips a campaign to
`PUBLISHED` without the payment/approval checks that
`PATCH /api/ads/:id/telegram-publication` performs. It is admin-only now, but
consider removing that side effect and using the dedicated endpoint.
