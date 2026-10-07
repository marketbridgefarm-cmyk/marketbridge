# MarketBridge — Negotiation Leaf & Waiting-Buyer Quantity Fix

- Superseded parent negotiation rows can no longer be acted on as the live leaf.
- Seller selection validates the bid quantity against current listing availability.
- Automatic waiting-buyer promotion ignores offers whose quantity exceeds remaining inventory.
- Regression coverage protects the stale-parent invariant.

Extract at the repository root and replace the included files.
