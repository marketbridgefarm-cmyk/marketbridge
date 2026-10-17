# Inspector arrival proof, handshake code, reliability and fee escrow

This zip is **cumulative**: it holds every file changed in this whole session (earlier splits and
fixes included), so copy it over the repo in one go. `AUDIT-AND-CHANGES.md` from the previous zip still applies.

## New flow
1. **Seller: "Accept inspector and fee"** (`POST /inspections/:id/seller-confirm`). Locks the fee terms and
   creates a handshake salt. It no longer claims the inspector is on site. The next deadline is the
   *arrival window* (72h); the 24h fee-payment clock starts only after arrival is confirmed.
2. **Inspector: "Check in on site"** (`POST /inspections/:id/arrival/check-in`, multipart): GPS + timestamp + photo
   (all required), plus an optional 4-digit handshake code.
   * correct code: arrival is confirmed immediately (the seller was physically there to say it);
   * no code: the seller gets a short window (2h) to answer.
3. **Seller: "Yes, they are here"** (`POST .../arrival/confirm`) confirms. Silence auto-confirms when the window
   ends (never blocks). "No, they are not here" (`POST .../arrival/dispute`, three closed reasons, no typing) goes to admin.
4. **Admin tab "Inspector Arrivals"** shows GPS fix (map link), distance from the listing, photo, handshake status, the
   seller's reason and the inspector's reliability, then rules **ARRIVED** (arrival confirmed, payment opens) or
   **NO_SHOW** (counted against the inspector, standing penalty, bidding reopens, **the buyer's order is kept**).
5. Confirming arrival sets `inspectorOnSiteConfirmedAt`, the same gate payment/start/report already used.
   Nothing downstream changed.

The handshake code is derived (HMAC of request + inspector + salt), never stored, shown only to the seller, rotates when
the inspector is replaced, and locks after 5 wrong tries (checking in without a code still works).
Check-ins far from the listing (> 5 km) or after the agreed time are flagged for admin, never blocked.

## Other items
* **Reminders**: every inspection deadline (seller acceptance, inspector arrival, fee payment) now notifies at about
  12h and 2h before it, to the people who can act. This replaces the old single 3-4h seller-only reminder.
* **Reliability**: `InspectorReliability` counts on-time/late arrivals, no-shows and report turnaround. Score 0-100
  (new inspectors start neutral at 90, tier "New"). The bid list is ordered by reliability, then fee, with a "Best match"
  label and a badge; the requester can still pick any bid. Inspectors see their own record on their dashboard.
* **Escrow**: inspector fees were already held (`Payout HELD`) and never released before the report. Now release happens
  when the **buyer accepts the report** (new button, instant) or automatically **48h after the report is submitted**
  (`INSPECTION_REPORT_REVIEW_HOURS`), replacing the old fixed 3-day hold for inspectors. Disputes still freeze payouts.


## Fee protection after the report is submitted
Once the inspector has submitted the report, the work is done, so the fee is protected:
* **Order cancellation** (buyer, seller, admin, or automatic): the completed inspection stays `COMPLETED` (the report stays readable),
  the inspector's payout is **kept** and releases after the review window or when the buyer accepts, and the inspection payment is
  **not refunded**. Everything else on the order is cancelled and refunded as before. The cancellation audit record lists the retained
  inspection and payment ids. Cancel confirmations in the buyer UI now say so.
* **Disputes**: goods, transport and unclassified order disputes no longer freeze the inspector's payout.
* **One deliberate exception**: a dispute that is explicitly about the inspection report (type mentions INSPECT) still freezes the fee,
  so a fabricated report cannot be paid out while it is contested. The buyer's only other protection is the review window.
  Set `INSPECTOR_FEE_FREEZE_ON_REPORT_DISPUTE=false` to remove even that. An inspector who has *not* submitted a report is unaffected
  by this change (cancellation and disputes behave as before).
* Not changed: an admin can still refund an inspection payment manually, for example in a proven-fraud case.

## Deploy
```bash
# BEFORE deploying, check for requests caught mid-way through the old split flow:
#   SELECT id FROM "InspectionRequest" WHERE status='ACCEPTED' AND "sellerConfirmedAt" IS NOT NULL AND "inspectorOnSiteConfirmedAt" IS NULL;
# Expect zero rows. Any row would be treated as awaiting arrival and could lapse as a no-show.
cd backend && npx prisma migrate deploy && npx prisma generate
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DB"   # expect no drift
node --test test/*.test.js     # after deleting backend/test/installmentService.js (stray duplicate)
```
New optional env vars are documented in `backend/.env.example` (defaults are sensible).

## Verified here / not verified
* Verified: syntax of every file; undefined-name check (backend + frontend); every Prisma field and enum value used exists in
  the schema; schema and migration agree; all 251 frontend API calls map to a backend route.
* **51 new tests, all passing** (pure logic, the arrival service against an in-memory database, escrow release rules).
  The full backend suite: same 20 failures as the untouched project (missing dependencies/database here), no new failures.
* Rendered the arrival panel per role with injected state: seller sees the code and confirm/dispute; the inspector sees only
  the check-in form; the buyer sees status only.
* **Not verified**: the migration against a real PostgreSQL (written by hand to mirror the schema, so run `prisma migrate diff`),
  real GPS/camera on phones, real object storage, and the SMS/notification delivery of the new events (English text only; other
  languages fall back to English). Click through it on staging as inspector, seller, buyer and admin.

## Decisions worth a second look
* Auto-confirm on seller silence is what you asked for. The trade-off: an absent seller plus a dishonest inspector gets an
  arrival confirmed. The record (GPS, photo, distance flag) stays on file, the fee is only released after a report and the review
  window, and the buyer can dispute then. A seller cannot dispute after auto-confirmation.
* Payment still happens after arrival (unchanged), so a no-show costs the buyer nothing.
* Reliability counters start at deployment (no backfill of history).
* `frontend/src/pages/AdminSecuritySettings.jsx` is not imported or routed anywhere, so the MFA fixes from the earlier zip only help once you add a route to it.
