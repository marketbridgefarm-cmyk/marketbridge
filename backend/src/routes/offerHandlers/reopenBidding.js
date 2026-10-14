const prisma = require('../../config/db');
const { offerError } = require('../../services/offers/offerHelpers');
const { noticeWaitingUnlocked } = require('../../services/waitingListService');
const { recordAuditEvent } = require('../../utils/audit');

// PATCH /api/offers/listing/:listingId/reopen-bidding (admin + MFA)
async function reopenBidding(req, res) {
  try {
    const listingId = req.params.listingId;

    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
    });

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    if (!['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'].includes(listing.status)) {
      return res.status(409).json({
        error: `Bidding cannot be reopened while the listing is ${listing.status}`,
      });
    }

    const reopened = await prisma.$transaction(async (tx) => {
      const lockedListings = await tx.$queryRaw`
        SELECT "id", "status"
        FROM "Listing"
        WHERE "id" = ${listingId}
        FOR UPDATE
      `;
      if (!lockedListings?.length) {
        throw offerError('Listing not found', 404);
      }

      const freshStatus = lockedListings[0].status;
      if (!['ACTIVE', 'UNDER_NEGOTIATION', 'SOLD'].includes(freshStatus)) {
        throw offerError(
          `Bidding cannot be reopened while the listing is ${freshStatus}`,
          409
        );
      }

      const liveLeafOffers = await tx.offer.count({
        where: {
          listingId,
          status: { in: ['PENDING', 'SELECTED', 'COUNTERED', 'PROVISIONAL', 'ACCEPTED'] },
          childOffers: { none: {} },
        },
      });
      if (liveLeafOffers > 0) {
        throw offerError(
          `A fresh bidding round cannot be opened while ${liveLeafOffers} offer(s) are still waiting or in negotiation. They stay locked until the current negotiation or order ends.`,
          409
        );
      }

      const activeOrder = await tx.order.findFirst({
        where: {
          listingId,
          status: { notIn: ['CANCELLED', 'COMPLETED'] },
        },
        select: { id: true, status: true },
      });
      if (activeOrder) {
        throw offerError(
          'Bidding cannot be reopened while an active provisional order exists on this listing. Cancel or complete that order first.',
          409
        );
      }

      const activePayment = await tx.payment.findFirst({
        where: {
          order: { listingId },
          status: { in: ['PENDING', 'PROCESSING', 'PAID', 'RECONCILIATION_REQUIRED'] },
        },
        select: { id: true, status: true },
      });
      if (activePayment) {
        throw offerError(
          'Bidding cannot be reopened after a payment has started or completed for this listing.',
          409
        );
      }

      const updated = await tx.listing.update({
        where: { id: listingId },
        data: { status: 'ACTIVE' },
      });

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: 'LISTING_BIDDING_REOPENED',
        resourceType: 'Listing',
        resourceId: updated.id,
        metadata: {
          previousStatus: freshStatus,
          liveLeafOffers: 0,
        },
      });

      return updated;
    }, { maxWait: 10000, timeout: 15000 });

    await noticeWaitingUnlocked(prisma, {
      listingId: reopened.id,
      reason: 'ADMIN_REOPENED_BIDDING',
    });

    return res.json({
      message: 'Fresh bidding round opened for this listing.',
      listing: reopened,
    });
  } catch (error) {
    req.log.error({ err: error }, 'REOPEN LISTING BIDDING ERROR:');

    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    return res.status(500).json({
      error: 'Could not reopen bidding for this listing',
    });
  }
}

module.exports = { reopenBidding };
