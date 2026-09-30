# Negotiation fixes (buyer <-> inspector, buyer <-> truck owner)

Copy these files over the same paths in the project. No database migration, no new dependencies, no API route changes.

## Root causes fixed

1. **Rejecting a counter did not end the negotiation.** Only the last row was marked REJECTED; the earlier COUNTERED rows stayed "live" and reappeared as actionable offers (Negotiations page / BidBoard), and the backend would still accept actions on them.
   - Backend: reject now closes the whole counter chain (inspection + transport), inside a transaction with a fresh-state check. Transport reject is now audited too.
   - Backend: only the newest row of a chain can be selected/accepted/countered/rejected/released (`409 QUOTE_SUPERSEDED` otherwise).
   - Frontend: BidBoard and the provider-side list now find the latest row across ALL statuses before hiding rejected rows.
2. **Inspector never saw that their bid was selected.** `/inspections/available` dropped SELECTED quotes, so the inspector saw nothing and could even file a duplicate bid. SELECTED (plus WITHDRAWN/EXPIRED) is now returned; the duplicate-bid check also covers SELECTED and ACCEPTED.
3. **Inspector dashboard showed the oldest row of the chain** (a rejected bid hid the live one). It now uses the most recent leaf.
4. **Truck owner could not cancel an accepted deal.** The button sent REJECT (only valid for in-negotiation quotes); it now sends WITHDRAW. The button was also only rendered for job status ACCEPTED, which the backend does not use before payment.
5. **Truck owner with an accepted quote was told "Waiting for the requester to select a transporter".** The job stays QUOTED until payment; the dashboard now shows "Agreement reached at X ETB - waiting for payment" (with release option before payment) and no longer offers to submit another quote.
6. **Expired negotiations froze everything.** Expired threads blocked re-bidding and the transport "competition frozen" check. Expired rows are now ignored by those checks, BidBoard disables accept/counter on expired quotes (Reject stays available), and selecting a bid refreshes its expiry so it cannot expire mid-negotiation.
7. **Requester's inspection bids had no provider name** because /orders did not include the inspector. Added inspector, message and child-count to the quote payload (plus child-count for transport quotes).
8. **Sealed-bid leak:** `GET /transport/:id/quotes` returned every competitor's quote to the assigned truck owner (and 403'd other truck owners). Non-arranging truck owners now get only their own quotes.
9. Order-lock failures (dispute/cancel) on accept/counter/reject/release returned 500; they now return the intended 409 message.

## Files
- backend/src/routes/inspections.js
- backend/src/routes/transport.js
- backend/src/routes/orders.js
- backend/test/marketplace.e2e.test.js (now selects a bid before accepting, matching the competitive flow)
- frontend/src/components/BidBoard.jsx
- frontend/src/pages/Negotiations.jsx
- frontend/src/pages/TruckOwnerDashboard.jsx
- frontend/src/pages/InspectorDashboard.jsx

## Not verified
Changes were syntax-checked (node --check / tsc) only; dependencies and a database were not available here, so the e2e test and the UI were not run.
