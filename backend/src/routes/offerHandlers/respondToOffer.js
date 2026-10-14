const prisma = require('../../config/db');
const { isAdmin, isOfferExpired, expireOfferIfNeeded } = require('../../services/offers/offerHelpers');
const { selectOffer } = require('./actions/select');
const { acceptSelected } = require('./actions/acceptSelected');
const { acceptCounter } = require('./actions/acceptCounter');
const { acceptOffer } = require('./actions/accept');
const { reCounter } = require('./actions/reCounter');
const { releaseBuyer } = require('./actions/release');
const { confirmProvisional } = require('./actions/confirmProvisional');
const { releaseProvisional } = require('./actions/releaseProvisional');
const { rejectOrWithdraw } = require('./actions/rejectOrWithdraw');
const { counterOffer } = require('./actions/counter');

// PATCH /api/offers/:id — loads the offer, checks the caller is a participant,
// handles expiry, then dispatches to the handler for the requested action.
// Each action's logic lives in ./actions/<action>.js.

const actionHandlers = {
  SELECT: selectOffer,
  ACCEPT_SELECTED: acceptSelected,
  ACCEPT_COUNTER: acceptCounter,
  ACCEPT: acceptOffer,
  RE_COUNTER: reCounter,
  RELEASE: releaseBuyer,
  CONFIRM_PROVISIONAL: confirmProvisional,
  RELEASE_PROVISIONAL: releaseProvisional,
  REJECT: rejectOrWithdraw,
  WITHDRAW: rejectOrWithdraw,
  COUNTER: counterOffer,
};

async function respondToOffer(req, res) {
  try {
    const { action } = req.body;

    const allowedActions = [
      'ACCEPT',
      'REJECT',
      'COUNTER',
      'ACCEPT_COUNTER',
      'ACCEPT_SELECTED',
      'RE_COUNTER',
      'SELECT',
      'WITHDRAW',
      'RELEASE',
      'CONFIRM_PROVISIONAL',
      'RELEASE_PROVISIONAL',
    ];

    if (
      !allowedActions.includes(action)
    ) {
      return res.status(400).json({
        error:
          `Invalid action. Use ${allowedActions.join(', ')}.`,
      });
    }

    const offer =
      await prisma.offer.findUnique({
        where: {
          id: req.params.id,
        },

        include: {
          listing: true,
        },
      });

    if (!offer) {
      return res.status(404).json({
        error: 'Offer not found',
      });
    }

    const sellerId =
      offer.listing.sellerId;

    const isSeller =
      sellerId === req.user.id;

    const isBuyer =
      offer.buyerId === req.user.id;

    const admin = isAdmin(req);

    if (!isSeller && !isBuyer && !admin) {
      return res.status(403).json({
        error:
          'You are not a participant in this offer',
      });
    }

    if (isOfferExpired(offer)) {
      await prisma.$transaction(async (tx) => {
        await expireOfferIfNeeded(tx, offer, req.user.id);
      }, { maxWait: 10000, timeout: 15000 });
      return res.status(409).json({
        error: 'Offer has expired and can no longer be acted on',
      });
    }

    const handler = actionHandlers[action];
    if (handler) {
      // `await` keeps thrown offerError()s inside this try/catch.
      return await handler(req, res, { action, offer, sellerId, isSeller, isBuyer, admin });
    }

    return res.status(400).json({
      error:
        'Unsupported offer action',
    });
  } catch (error) {
    req.log.error({ err: error }, 'RESPOND TO OFFER ERROR:');

    if (error.statusCode) {
      return res
        .status(error.statusCode)
        .json({
          error: error.message,
        });
    }

    if (
      error.code === 'P2002'
    ) {
      return res.status(409).json({
        error:
          'A conflicting offer or order already exists',
      });
    }

    return res.status(500).json({
      error:
        'Could not respond to offer',

      details:
        process.env.NODE_ENV ===
        'development'
          ? error.message
          : undefined,
    });
  }
}

module.exports = { respondToOffer };
