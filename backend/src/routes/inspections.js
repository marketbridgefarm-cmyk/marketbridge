const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/roleCheck");

const router = express.Router();
const prisma = new PrismaClient();


/*
  BUYER/SELLER INSPECTION REQUESTS
*/
router.get(
  "/mine",
  requireAuth,
  requireRole("BUYER", "SELLER"),
  async (req, res) => {
    try {
      const requests = await prisma.inspectionRequest.findMany({
        where: {
          OR: [
            {
              requestedById: req.user.id,
            },
            {
              listing: {
                sellerId: req.user.id,
              },
            },
            {
              inspectorId: req.user.id,
            },
          ],
        },
        include: {
          listing: true,
          requestedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          inspector: {
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

      return res.json(requests);
    } catch (error) {
      console.error("Get inspections error:", error);

      return res.status(500).json({
        error: "Failed to load inspections",
      });
    }
  }
);


/*
  CREATE INSPECTION REQUEST
*/
router.post(
  "/",
  requireAuth,
  requireRole("BUYER", "SELLER"),
  async (req, res) => {
    try {
      const {
        listingId,
        mode = "BUYER_REQUESTED",
        inspectorId,
      } = req.body;

      if (!listingId) {
        return res.status(400).json({
          error: "listingId is required",
        });
      }

      const listing = await prisma.listing.findUnique({
        where: {
          id: listingId,
        },
      });

      if (!listing) {
        return res.status(404).json({
          error: "Listing not found",
        });
      }

      if (!["SELLER_REQUESTED", "BUYER_REQUESTED", "JOINT"].includes(mode)) {
        return res.status(400).json({
          error: "Invalid inspection mode",
        });
      }

      if (
        mode === "SELLER_REQUESTED" &&
        listing.sellerId !== req.user.id
      ) {
        return res.status(403).json({
          error: "Only the seller can create a seller-requested inspection",
        });
      }

      if (inspectorId) {
        const inspector = await prisma.user.findUnique({
          where: {
            id: inspectorId,
          },
        });

        if (!inspector) {
          return res.status(404).json({
            error: "Inspector not found",
          });
        }

        if (!inspector.roles?.includes("INSPECTOR")) {
          return res.status(400).json({
            error: "Selected user is not an inspector",
          });
        }
      }

      const request = await prisma.inspectionRequest.create({
        data: {
          listingId,
          requestedById: req.user.id,
          mode,
          inspectorId: inspectorId || null,
          status: "REQUESTED",
        },
        include: {
          listing: true,
          requestedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          inspector: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      return res.status(201).json(request);
    } catch (error) {
      console.error("Create inspection error:", error);

      return res.status(500).json({
        error: "Failed to create inspection request",
      });
    }
  }
);


/*
  GET AVAILABLE INSPECTORS
*/
router.get(
  "/inspectors",
  requireAuth,
  async (req, res) => {
    try {
      const inspectors = await prisma.user.findMany({
        where: {
          roles: {
            has: "INSPECTOR",
          },
        },
        select: {
          id: true,
          name: true,
          email: true,
        },
        orderBy: {
          name: "asc",
        },
      });

      return res.json(inspectors);
    } catch (error) {
      console.error("Get inspectors error:", error);

      return res.status(500).json({
        error: "Failed to load inspectors",
      });
    }
  }
);


/*
  INSPECTOR ACCEPTS REQUEST
*/
router.patch(
  "/:id/accept",
  requireAuth,
  requireRole("INSPECTOR"),
  async (req, res) => {
    try {
      const inspection = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },
      });

      if (!inspection) {
        return res.status(404).json({
          error: "Inspection request not found",
        });
      }

      if (
        inspection.status !== "REQUESTED"
      ) {
        return res.status(409).json({
          error: "Inspection request is no longer available",
        });
      }

      const updated = await prisma.inspectionRequest.update({
        where: {
          id: inspection.id,
        },
        data: {
          inspectorId: req.user.id,
          status: "ACCEPTED",
        },
        include: {
          listing: true,
          requestedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          inspector: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      return res.json(updated);
    } catch (error) {
      console.error("Accept inspection error:", error);

      return res.status(500).json({
        error: "Failed to accept inspection",
      });
    }
  }
);


/*
  INSPECTOR SUBMITS REPORT
*/
router.post(
  "/:id/report",
  requireAuth,
  requireRole("INSPECTOR"),
  async (req, res) => {
    try {
      const { report } = req.body;

      if (!report || !String(report).trim()) {
        return res.status(400).json({
          error: "Inspection report is required",
        });
      }

      const inspection = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },
      });

      if (!inspection) {
        return res.status(404).json({
          error: "Inspection request not found",
        });
      }

      if (inspection.inspectorId !== req.user.id) {
        return res.status(403).json({
          error: "You are not assigned to this inspection",
        });
      }

      const updated = await prisma.inspectionRequest.update({
        where: {
          id: inspection.id,
        },
        data: {
          report: String(report).trim(),
          status: "COMPLETED",
        },
        include: {
          listing: true,
          requestedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          inspector: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      return res.json(updated);
    } catch (error) {
      console.error("Submit inspection report error:", error);

      return res.status(500).json({
        error: "Failed to submit inspection report",
      });
    }
  }
);

module.exports = router;
