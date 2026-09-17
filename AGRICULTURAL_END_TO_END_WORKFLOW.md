# Agricultural end-to-end workflow correction

Canonical lifecycle:

SELLER publishes produce -> BUYER submits offer -> buyer/seller negotiation -> agreed price -> order created -> order-owned inspection request -> inspector quote negotiation -> inspection payment -> inspection -> report -> buyer BUY/CANCEL -> if BUY, seller payment -> transport arrangement -> transport negotiation -> transport accepted -> transport payment -> pickup evidence -> pickup -> IN_TRANSIT -> delivery evidence -> DELIVERED -> buyer receipt confirmation -> COMPLETED.

Key invariants:
- An inspection belongs to an Order, not only a Listing.
- An accepted offer is linked to Order.agreedOfferId/agreedAt.
- Agricultural order payment expiry does not start until BUY is selected.
- Inspection payment is required before an accepted inspection can start.
- Seller/goods payment requires a completed inspection report and explicit BUY.
- Agricultural transport arrangement requires BUY, seller payment, and required inspection payments.
- Transport pickup requires all required payments and pickup evidence; movement is transporter-controlled.
- Order status synchronizes with IN_TRANSIT and DELIVERED transport states.
- Buyer receipt confirmation is the final COMPLETED gate.
