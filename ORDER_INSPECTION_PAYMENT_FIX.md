# Agricultural Order Inspection/Payment Fix — 2026-09-17

## Problem fixed

An agricultural order could have duplicate non-cancelled inspection requests because the buyer/seller continued to see both **Request inspection** and **Find an inspector** after an inspection already existed.

The backend goods-payment gate examined every non-cancelled inspection request. A stale/duplicate request in `REQUESTED`, `ACCEPTED`, or `IN_PROGRESS` could therefore block the buyer from paying the seller even when the inspection that had actually been performed was already completed and its report existed.

## Changes

1. `backend/src/routes/inspections.js`
   - Prevents a second active inspection workflow once an active order exists for the listing.
   - Returns HTTP 409 with `ACTIVE_INSPECTION_EXISTS` instead of creating a duplicate.
   - Allows a completed pre-order inspection to coexist with a new request only when there is no active order.

2. `backend/src/routes/payments.js`
   - Uses the newest non-cancelled inspection as the canonical inspection for agricultural goods-payment gating.
   - Requires both `COMPLETED` status and an actual inspection report before seller payment is created.
   - Stops stale duplicate historical requests from incorrectly blocking payment.

3. `backend/src/services/orderWorkflowService.js`
   - Uses the newest active inspection as the canonical workflow/read-model inspection.
   - Payment status, stage, and Action Center no longer treat stale duplicate requests as a second inspection gate.

4. `frontend/src/pages/OrderDetail.jsx`
   - Uses the newest active inspection as the current inspection.
   - Hides duplicate inspection request/search controls when an inspection already exists.
   - Shows inspection status/inspector/fee instead.
   - Enables the seller-payment button only when the current agricultural inspection has a published report.

5. `frontend/src/pages/ListingDetail.jsx`
   - Hides duplicate inspection request/search controls when an inspection already exists.

## Intended sequence after this fix

Inspection fee payment can happen before the inspection report, as currently supported.

The buyer's goods/seller payment becomes available only after:

`Inspection requested → accepted/negotiated → inspection payment → inspection performed → inspection report published → buyer can pay seller`

Transport remains independently negotiated and paid according to its own workflow.

## Validation

Backend JavaScript syntax checks pass for all three changed backend files.

A full `npm test` / frontend build could not be completed in this environment because dependency installation (`npm ci`) timed out before dependencies became available.
