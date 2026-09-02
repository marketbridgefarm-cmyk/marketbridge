const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

const orderInclude = {
  listing: {
    include: {
      inspectionRequests: {
        include: {
          inspector: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          requestedBy: {
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
  seller: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
};


/*
  GET ALL ORDERS FOR CURRENT USER
*/
router.get("/", requireAuth, async (req, res) => {
  try {
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
      include: orderInclude,
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.json(orders);
  } catch (error) {
    console.error("Get orders error:", error);

    return res.status(500).json({
      error: "Failed to load orders",
    });
  }
});


/*
  GET ONE ORDER
*/
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: {
        id: req.params.id,
      },
      include: orderInclude,
    });

    if (!order) {
      return res.status(404).json({
        error: "Order not found",
      });
    }

    if (
      order.buyerId !== req.user.id &&
      order.sellerId !== req.user.id
    ) {
      return res.status(403).json({
        error: "You are not authorized to view this order",
      });
    }

    return res.json(order);
  } catch (error) {
    console.error("Get order error:", error);

    return res.status(500).json({
      error: "Failed to load order",
    });
  }
});


/*
  CANCEL ORDER

  When a temporary reservation is cancelled:
  - order becomes CANCELLED
  - listing becomes ACTIVE again
  - another buyer can see/make an offer on it
*/
router.patch("/:id/cancel", requireAuth, async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: {
          id: req.params.id,
        },
      });

      if (!order) {
        throw new Error("ORDER_NOT_FOUND");
      }

      if (
        order.buyerId !== req.user.id &&
        order.sellerId !== req.user.id
      ) {
        throw new Error("FORBIDDEN");
      }

      if (
        order.status === "COMPLETED" ||
        order.status === "CANCELLED"
      ) {
        throw new Error("ORDER_ALREADY_CLOSED");
      }

      const updatedOrder = await tx.order.update({
        where: {
          id: order.id,
        },
        data: {
          status: "CANCELLED",
        },
        include: orderInclude,
      });

      /*
        Only release the listing if there isn't another
        active order for the same listing.
      */
      const anotherActiveOrder = await tx.order.findFirst({
        where: {
          listingId: order.listingId,
          id: {
            not: order.id,
          },
          status: {
            notIn: ["CANCELLED", "COMPLETED"],
          },
        },
      });

      if (!anotherActiveOrder) {
        await tx.listing.update({
          where: {
            id: order.listingId,
          },
          data: {
            status: "ACTIVE",
          },
        });
      }

      return updatedOrder;
    });

    return res.json({
      success: true,
      message: "Order cancelled and listing released",
      order: result,
    });
  } catch (error) {
    console.error("Cancel order error:", error);

    if (error.message === "ORDER_NOT_FOUND") {
      return res.status(404).json({
        error: "Order not found",
      });
    }

    if (error.message === "FORBIDDEN") {
      return res.status(403).json({
        error: "You are not authorized to cancel this order",
      });
    }

    if (error.message === "ORDER_ALREADY_CLOSED") {
      return res.status(409).json({
        error: "This order is already closed",
      });
    }

    return res.status(500).json({
      error: "Failed to cancel order",
    });
  }
});


/*
  BUYER CONFIRMS RECEIPT

  Completing the order permanently marks the listing SOLD.
*/
router.patch(
  "/:id/confirm-receipt",
  requireAuth,
  async (req, res) => {
    try {
      const order = await prisma.order.findUnique({
        where: {
          id: req.params.id,
        },
      });

      if (!order) {
        return res.status(404).json({
          error: "Order not found",
        });
      }

      if (order.buyerId !== req.user.id) {
        return res.status(403).json({
          error: "Only the buyer can confirm receipt",
        });
      }

      if (
        order.status === "CANCELLED" ||
        order.status === "COMPLETED"
      ) {
        return res.status(409).json({
          error: "This order is already closed",
        });
      }

      const updatedOrder = await prisma.$transaction(
        async (tx) => {
          const updated = await tx.order.update({
            where: {
              id: order.id,
            },
            data: {
              status: "COMPLETED",
            },
            include: orderInclude,
          });

          await tx.listing.update({
            where: {
              id: order.listingId,
            },
            data: {
              status: "SOLD",
            },
          });

          return updated;
        }
      );

      return res.json({
        success: true,
        message: "Receipt confirmed",
        order: updatedOrder,
      });
    } catch (error) {
      console.error("Confirm receipt error:", error);

      return res.status(500).json({
        error: "Failed to confirm receipt",
      });
    }
  }
);

module.exports = router;
