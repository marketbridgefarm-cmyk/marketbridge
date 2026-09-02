const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/roleCheck");

const router = express.Router();
const prisma = new PrismaClient();

/*
  Buyer creates an offer.
  IMPORTANT:
  - Only ACTIVE listings can receive new offers.
  - Creating a pending/countered offer does NOT remove the listing.
*/
router.post(
  "/",
  requireAuth,
  requireRole("BUYER"),
  async (req, res) => {
    try {
      const { listingId, amount } = req.body;

      if (!listingId || amount === undefined || amount === null) {
        return res.status(400).json({
          error: "listingId and amount are required",
        });
      }

      const numericAmount = Number(amount);

      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({
          error: "Offer amount must be greater than zero",
        });
      }

      const listing = await prisma.listing.findUnique({
        where: { id: listingId },
      });

      if (!listing) {
        return res.status(404).json({
          error: "Listing not found",
        });
      }

      if (listing.status !== "ACTIVE") {
        return res.status(409).json({
          error: "This listing is currently unavailable",
        });
      }

      if (listing.sellerId === req.user.id) {
        return res.status(400).json({
          error: "You cannot make an offer on your own listing",
        });
      }

      const existingOffer = await prisma.offer.findFirst({
        where: {
          listingId,
          buyerId: req.user.id,
          status: {
            in: ["PENDING", "COUNTERED"],
          },
        },
      });

      if (existingOffer) {
        return res.status(409).json({
          error: "You already have an active offer on this listing",
        });
      }

      const offer = await prisma.offer.create({
        data: {
          listingId,
          buyerId: req.user.id,
          amount: numericAmount,
          status: "PENDING",
        },
        include: {
          listing: true,
          buyer: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      /*
        DO NOT change listing status here.

        Pending offers must NOT make the listing disappear
        from buyer availability.
      */

      return res.status(201).json(offer);
    } catch (error) {
      console.error("Create offer error:", error);

      return res.status(500).json({
        error: "Failed to create offer",
      });
    }
  }
);


/*
  Get current buyer's/seller's offers.

  For ACCEPTED buyer offers, also attach the corresponding order.
  This makes the buyer dashboard immediately aware that an order
  was created after acceptance.
*/
router.get(
  "/mine",
  requireAuth,
  async (req, res) => {
    try {
      const isBuyer = req.user.roles?.includes("BUYER");
      const isSeller = req.user.roles?.includes("SELLER");

      let where = {};

      if (isBuyer && !isSeller) {
        where = {
          buyerId: req.user.id,
        };
      } else if (isSeller && !isBuyer) {
        where = {
          listing: {
            sellerId: req.user.id,
          },
        };
      } else {
        where = {
          OR: [
            {
              buyerId: req.user.id,
            },
            {
              listing: {
                sellerId: req.user.id,
              },
            },
          ],
        };
      }

      const offers = await prisma.offer.findMany({
        where,
        include: {
          listing: {
            include: {
              seller: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          },
          buyer: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      /*
        Find this user's orders and match accepted offers
        by listingId.
      */
      const orders = await prisma.order.findMany({
        where: {
          OR: [
            {
              buyerId: req.user.id,
            },
            {
              sellerId: req.user.id,
            },
          ],
        },
        include: {
          listing: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      const ordersByListing = new Map();

      for (const order of orders) {
        if (!ordersByListing.has(order.listingId)) {
          ordersByListing.set(order.listingId, order);
        }
      }

      const result = offers.map((offer) => {
        if (offer.status !== "ACCEPTED") {
          return {
            ...offer,
            order: null,
          };
        }

        return {
          ...offer,
          order: ordersByListing.get(offer.listingId) || null,
        };
      });

      return res.json(result);
    } catch (error) {
      console.error("Get my offers error:", error);

      return res.status(500).json({
        error: "Failed to load offers",
      });
    }
  }
);


/*
  Seller accepts/rejects/counters an offer.

  ACCEPT:
  - Must be PENDING or COUNTERED.
  - Listing must still be available.
  - Listing becomes UNDER_NEGOTIATION temporarily.
  - Selected offer becomes ACCEPTED.
  - Competing active offers are rejected.
  - An Order is created for the buyer.
*/
router.patch(
  "/:id",
  requireAuth,
  requireRole("SELLER"),
  async (req, res) => {
    const offerId = req.params.id;
    const { action, counterAmount } = req.body;

    if (!["ACCEPT", "REJECT", "COUNTER"].includes(action)) {
      return res.status(400).json({
        error: "Invalid action",
      });
    }

    try {
      const existingOffer = await prisma.offer.findUnique({
        where: {
          id: offerId,
        },
        include: {
          listing: true,
        },
      });

      if (!existingOffer) {
        return res.status(404).json({
          error: "Offer not found",
        });
      }

      if (existingOffer.listing.sellerId !== req.user.id) {
        return res.status(403).json({
          error: "You are not authorized to manage this offer",
        });
      }

      if (!["PENDING", "COUNTERED"].includes(existingOffer.status)) {
        return res.status(409).json({
          error: `Offer is already ${existingOffer.status.toLowerCase()}`,
        });
      }


      /*
        ACCEPT
      */
      if (action === "ACCEPT") {
        const result = await prisma.$transaction(async (tx) => {
          /*
            ACTIVE is the normal available state.

            UNDER_NEGOTIATION is also accepted here only when there
            is no existing order/accepted offer. This protects against
            listings that were left in UNDER_NEGOTIATION by the old
            buggy implementation.
          */
          const currentListing = await tx.listing.findUnique({
            where: {
              id: existingOffer.listingId,
            },
          });

          if (!currentListing) {
            throw new Error("LISTING_NOT_FOUND");
          }

          if (
            currentListing.status !== "ACTIVE" &&
            currentListing.status !== "UNDER_NEGOTIATION"
          ) {
            throw new Error("LISTING_UNAVAILABLE");
          }

          const existingOrder = await tx.order.findFirst({
            where: {
              listingId: existingOffer.listingId,
              status: {
                notIn: ["CANCELLED", "COMPLETED"],
              },
            },
          });

          if (existingOrder) {
            throw new Error("ORDER_ALREADY_EXISTS");
          }

          const acceptedOffer = await tx.offer.findFirst({
            where: {
              listingId: existingOffer.listingId,
              status: "ACCEPTED",
            },
          });

          if (acceptedOffer && acceptedOffer.id !== offerId) {
            throw new Error("ANOTHER_OFFER_ALREADY_ACCEPTED");
          }

          /*
            Concurrency guard:
            reserve the listing only if it is still ACTIVE or the
            legacy UNDER_NEGOTIATION state without an order.
          */
          await tx.listing.update({
            where: {
              id: existingOffer.listingId,
            },
            data: {
              status: "UNDER_NEGOTIATION",
            },
          });

          const updatedOffer = await tx.offer.update({
            where: {
              id: offerId,
            },
            data: {
              status: "ACCEPTED",
            },
            include: {
              listing: true,
              buyer: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          });

          /*
            Reject all other active offers for this listing.
          */
          await tx.offer.updateMany({
            where: {
              listingId: existingOffer.listingId,
              id: {
                not: offerId,
              },
              status: {
                in: ["PENDING", "COUNTERED"],
              },
            },
            data: {
              status: "REJECTED",
            },
          });

          /*
            Create the buyer's Order immediately.
          */
          const order = await tx.order.create({
            data: {
              listingId: existingOffer.listingId,
              buyerId: existingOffer.buyerId,
              sellerId: existingOffer.listing.sellerId,
              finalPrice: existingOffer.counterAmount ?? existingOffer.amount,
              status: "PENDING_PAYMENT",
            },
            include: {
              listing: true,
            },
          });

          return {
            offer: updatedOffer,
            order,
          };
        });

        return res.json({
          success: true,
          message: "Offer accepted and order created",
          offer: result.offer,
          order: result.order,
        });
      }


      /*
        REJECT
      */
      if (action === "REJECT") {
        const updatedOffer = await prisma.offer.update({
          where: {
            id: offerId,
          },
          data: {
            status: "REJECTED",
          },
          include: {
            listing: true,
            buyer: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        });

        /*
          IMPORTANT:
          Rejecting an offer does NOT change listing status.
        */

        return res.json({
          success: true,
          message: "Offer rejected",
          offer: updatedOffer,
        });
      }


      /*
        COUNTER
      */
      if (action === "COUNTER") {
        const numericCounter = Number(counterAmount);

        if (!Number.isFinite(numericCounter) || numericCounter <= 0) {
          return res.status(400).json({
            error: "A valid counter amount is required",
          });
        }

        const updatedOffer = await prisma.offer.update({
          where: {
            id: offerId,
          },
          data: {
            status: "COUNTERED",
            counterAmount: numericCounter,
          },
          include: {
            listing: true,
            buyer: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        });

        /*
          IMPORTANT:
          Countering an offer does NOT remove the listing.
        */

        return res.json({
          success: true,
          message: "Counter offer sent",
          offer: updatedOffer,
        });
      }
    } catch (error) {
      console.error("Update offer error:", error);

      if (error.message === "LISTING_NOT_FOUND") {
        return res.status(404).json({
          error: "Listing not found",
        });
      }

      if (error.message === "LISTING_UNAVAILABLE") {
        return res.status(409).json({
          error: "This listing is no longer available",
        });
      }

      if (error.message === "ORDER_ALREADY_EXISTS") {
        return res.status(409).json({
          error: "An order already exists for this listing",
        });
      }

      if (error.message === "ANOTHER_OFFER_ALREADY_ACCEPTED") {
        return res.status(409).json({
          error: "Another offer has already been accepted for this listing",
        });
      }

      return res.status(500).json({
        error: "Failed to update offer",
      });
    }
  }
);

module.exports = router;
