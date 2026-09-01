# MarketBridge

Ethiopian agricultural & digital marketplace platform. Connects Sellers/Farmers,
Buyers, Inspectors, and Truck Owners/Transporters, with party-controlled
transport (never automatically assigned to the buyer) and a separate digital
goods marketplace. Built from the Final Master Blueprint.

Stack: **React (Vite) frontend + Node/Express API + PostgreSQL (Prisma ORM)**,
JWT authentication.

## What's implemented

- **Auth**: register/login, multi-role accounts (a user can be e.g. both
  SELLER and BUYER), JWT sessions.
- **Agricultural marketplace**: listing creation, farmer price authority
  preserved even when an inspector creates a listing on the farmer's behalf,
  browse/search, price-insight endpoint (recent prices, demand, estimated net
  revenue).
- **Offers & negotiation**: buyer offers, seller accept/reject/counter, order
  creation on acceptance.
- **Inspection**: seller/buyer/joint requests, inspector comparison, accept,
  submit evidence-based reports (quantity, grade, moisture, defects, photos).
- **Party-controlled transport**: seller or buyer (or joint) arranges
  transport post-purchase; own-truck vs. hire-transporter; transport
  matching by area/capacity/type; status flow Requested → Accepted/Quoted →
  Pickup → In Transit → Delivered; own-truck use generates no
  transport-hiring commission.
- **Orders**: full lifecycle tracking, buyer receipt confirmation.
- **Payments**: modular records distinguishing Marketplace / Transport /
  Inspector / Advertising payments, method field for Telebirr/CBE/QR
  (gateway calls are stubbed — see "What's stubbed" below).
- **Digital marketplace**: independent sellers list/keep ownership of
  eBooks, templates, graphics, courses, etc.
- **Advertising**: Featured/Top-of-Category/Sponsored Search/Banner/Telegram
  ad records with admin approval.
- **Disputes**: raise, admin review, resolve/reject.
- **Ratings**: per-role ratings that roll up into a user's average.
- **Messaging**: simple threaded messages between users.
- **Admin dashboard**: overview metrics, user verification, basic fraud
  flagging, dispute resolution.
- **Frontend**: role-aware navigation and dashboards for every role
  (Seller, Buyer, Inspector, Truck Owner, Admin), listing browse/detail,
  offer + inspection + transport-arrangement flows, digital marketplace.

## What's stubbed / needs work before a real launch

- **Payment gateways**: Telebirr/CBE/QR are recorded as payment methods but
  not actually integrated — `POST /api/payments/:id/confirm` is a manual
  stand-in for their webhook/callback.
- **File uploads**: listing photos/videos and inspection evidence are stored
  as URL arrays — you'll want an actual upload flow (e.g. S3-compatible
  storage) rather than pasting URLs.
- **Telegram integration**: not built — the Advertisement model has a
  TELEGRAM_PROMOTION type ready to wire up to a bot.
- **Notifications/email/SMS**: not built.
- **Tests**: none yet — add integration tests per route before production.
- **Security hardening**: rate limiting is now in place (see below); input
  sanitization beyond basic validation, refresh tokens, and audit logging
  still need work. A first pass of authorization gaps (listing
  impersonation, ratings/disputes without participant checks, an open CORS
  fallback) has been fixed — see `SECURITY_NOTES.md`.
- **Deployment config**: no Dockerfile/CI yet — see "Deploying" below for a
  quick path.

## Rate limiting

`src/middleware/rateLimit.js` adds two limiters:
- A general limiter (300 req / 15 min per IP) on all of `/api`.
- A tighter limiter (20 req / 15 min per IP) on `/api/auth/register` and
  `/api/auth/login`, since those are the classic brute-force/credential-
  stuffing/fake-account targets.

Run `npm install` in `backend/` to pull in the new `express-rate-limit`
dependency before starting the server.

## CORS in production

`CLIENT_URL` is now **required** when `NODE_ENV=production` — the server
refuses to start rather than silently falling back to an open CORS policy.
Set it to your deployed frontend origin(s) (comma-separated for multiple).
In non-production environments, an unset `CLIENT_URL` still allows any
origin, for local dev convenience.

## Local setup

### 1. Database
Create a PostgreSQL database (locally or e.g. on Railway/Supabase/Neon).

### 2. Backend
```bash
cd backend
cp .env.example .env      # fill in DATABASE_URL and JWT_SECRET
npm install
npx prisma migrate dev --name init
npm run seed               # optional demo data (5 users, 1 listing, 1 truck)
npm run dev                 # http://localhost:4000
```

### 3. Frontend
```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

The Vite dev server proxies `/api` to `http://localhost:4000`.

### Demo logins (after `npm run seed`)
All passwords: `password123`
- farmer@example.com (SELLER)
- buyer@example.com (BUYER)
- inspector@example.com (INSPECTOR)
- trucker@example.com (TRUCK_OWNER)
- admin@example.com (ADMIN)

## Deploying (quick path)

- **Database**: managed Postgres (Railway, Supabase, Neon, RDS).
- **Backend**: Render/Railway/Fly.io — set the same env vars as `.env.example`,
  run `npx prisma migrate deploy` on release, then `npm start`.
- **Frontend**: Vercel/Netlify — `npm run build`, serve `dist/`, set the API
  base URL (update `vite.config.js` proxy or add an `VITE_API_URL` env var
  and point `src/api/client.js` at it for production).

## Project structure

```
marketbridge/
  backend/
    prisma/schema.prisma   # full data model (all 30 blueprint sections)
    prisma/seed.js
    src/
      index.js             # Express app entry
      config/db.js
      middleware/           # auth (JWT), roleCheck
      routes/                # auth, listings, offers, inspections, transport,
                              # orders, payments, ads, disputes, ratings,
                              # digital, messages, admin
  frontend/
    src/
      api/client.js         # axios instance with auth header
      context/AuthContext.jsx
      components/            # Navbar, ListingCard, ProtectedRoute
      pages/                 # Home, Login, Register, Listings, ListingDetail,
                              # CreateListing, DigitalMarketplace,
                              # Seller/Buyer/Inspector/TruckOwner/Admin
                              # dashboards, ArrangeTransport, OrderDetail
```

## Core business rules encoded in the code

- **Farmer price authority**: `POST /api/listings` blocks an inspector from
  listing produce under their own account; `PATCH /api/listings/:id` only
  allows the farmer (or admin) to change price/status, never the inspector.
- **Party-controlled transport**: `POST /api/transport` requires an explicit
  `arrangingParty` (SELLER/BUYER/JOINT) and is never auto-triggered by order
  confirmation; own-truck jobs skip creating a transport-hiring payment.
- **Inspector separation**: inspector routes only cover requests and
  reports — there is no route letting an inspector create or accept a
  transport job.


## Security / production checklist

- Do not commit `.env`; use `backend/.env.example` as the template. Rotate any credentials that were previously bundled in an archive.
- Production requires `JWT_SECRET` and `PAYMENT_WEBHOOK_SECRET` of at least 32 characters.
- Payment records are not proof of payment. Use the signed generic webhook endpoint or replace it with a provider-specific Telebirr/CBE adapter.
- Digital downloads are granted only after a verified `PAID` payment. For real production, store digital files in private object storage and return short-lived signed URLs instead of redirecting to a public URL.
- Run database migrations before starting the API: `npm run prisma:generate` then `npx prisma migrate deploy`.
- Run tests with `npm test`.


## Private digital-product storage

Digital product uploads now use private S3-compatible object storage. The API stores an opaque `fileKey`, never a public download URL. Buyers receive a short-lived signed download URL only after the related payment is verified.

Required backend environment variables: `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Optional: `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`. `DIGITAL_DOWNLOAD_EXPIRES_SECONDS` is capped at 15 minutes by the API.

Before deployment, create a private bucket with public access blocked and grant the API identity only `PutObject`, `GetObject`, and `DeleteObject` access to the MarketBridge prefix/bucket. Do not put storage credentials in source control.

The migration adds nullable private-storage metadata so existing products are not silently exposed. Legacy products with only `fileUrl` are intentionally blocked from download until their files are migrated into private storage.
