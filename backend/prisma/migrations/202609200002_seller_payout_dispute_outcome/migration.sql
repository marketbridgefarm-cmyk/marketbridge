-- Add a terminal state for seller payouts cancelled by an admin dispute resolution.
ALTER TYPE "SellerPayoutStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
