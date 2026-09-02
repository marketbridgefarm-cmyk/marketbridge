const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();

const inspectionInclude = {
  listing: {
    select: {
      id: true,
      title: true,
      cropType: true,
      quantity: true,
      unit: true,
      location: true,
      status: true,
    },
  },

  requestedBy: {
    select: {
      id: true,
      name: true,
      location: true,
      rating: true,
    },
  },

  inspector: {
    select: {
      id: true,
      name: true,
      location: true,
      rating: true,
      verificationStatus: true,
    },
  },

  report: true,
};


// ============================================================
// BUYER/SELLER INSPECTIONS
// ============================================================

router.get(
  '/mine',
  authenticate,
  requireRole('BUYER', 'SELLER'),
  async (req, res) => {
    try {
      const orders =
        await prisma.order.findMany({
          where: {
            OR: [
              {
                buyerId:
                  req.user.id,
              },
              {
                sellerId:
                  req.user.id,
              },
            ],
          },

          select: {
            listingId: true,
          },
        });

      const listingIds =
        orders.map(
          (order) =>
            order.listingId
        );

      const requests =
        await prisma.inspectionRequest.findMany({
          where: {
            OR: [
              {
                requestedById:
                  req.user.id,
              },

              ...(listingIds.length
                ? [
                    {
                      listingId: {
                        in: listingIds,
                      },
                    },
                  ]
                : []),
            ],
          },

          include:
            inspectionInclude,

          orderBy: {
            createdAt: 'desc',
          },
        });

      res.json({
        requests,
        count:
          requests.length,
      });
    } catch (error) {
      console.error(
        'MY INSPECTIONS ERROR:',
        error
      );

      res.status(500).json({
        error:
          'Could not load your inspection requests',
      });
    }
  }
);


// ============================================================
// CREATE INSPECTION REQUEST
// ============================================================

router.post(
  '/',
  authenticate,
  requireRole('SELLER', 'BUYER'),

  [
    body('listingId')
      .notEmpty(),

    body('mode')
      .isIn([
        'SELLER_REQUESTED',
        'BUYER_REQUESTED',
        'JOINT',
      ]),
  ],

  async (req, res) => {
    const errors =
      validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).json({
        errors:
          errors.array(),
      });
    }

    try {
      const {
        listingId,
        mode,
        inspectorId,
      } = req.body;

      const listing =
        await prisma.listing.findUnique({
          where: {
            id: listingId,
          },
        });

      if (!listing) {
        return res.status(404).json({
          error:
            'Listing not found',
        });
      }

      if (inspectorId) {
        const inspector =
          await prisma.user.findUnique({
            where: {
              id: inspectorId,
            },
          });

        if (
          !inspector ||
          !inspector.roles.includes(
            'INSPECTOR'
          )
        ) {
          return res.status(400).json({
            error:
              'inspectorId does not belong to a registered inspector',
          });
        }
      }

      if (
        mode ===
          'SELLER_REQUESTED' &&
        listing.sellerId !==
          req.user.id
      ) {
        return res.status(403).json({
          error:
            'Only the listing seller can create a seller-requested inspection',
        });
      }

      const request =
        await prisma.inspectionRequest.create({
          data: {
            listingId,

            requestedById:
              req.user.id,

            mode,

            inspectorId:
              inspectorId ||
              null,

            status:
              inspectorId
                ? 'ACCEPTED'
                : 'REQUESTED',
          },

          include:
            inspectionInclude,
        });

      res.status(201).json({
        request,
      });
    } catch (error) {
      console.error(
        'CREATE INSPECTION ERROR:',
        error
      );

      res.status(500).json({
        error:
          'Could not create inspection request',
      });
    }
  }
);


// ============================================================
// FIND INSPECTORS
// ============================================================

router.get(
  '/inspectors',
  authenticate,
  async (req, res) => {
    try {
      const {
        location,
      } = req.query;

      const inspectors =
        await prisma.user.findMany({
          where: {
            roles: {
              has: 'INSPECTOR',
            },

            ...(location && {
              location: {
                contains:
                  location,

                mode:
                  'insensitive',
              },
            }),
          },

          select: {
            id: true,
            name: true,
            rating: true,
            location: true,
            verificationStatus: true,
          },
        });

      res.json({
        inspectors,
      });
    } catch (error) {
      console.error(
        'GET INSPECTORS ERROR:',
        error
      );

      res.status(500).json({
        error:
          'Could not load inspectors',
      });
    }
  }
);


// ============================================================
// INSPECTOR ACCEPTS
// ============================================================

router.patch(
  '/:id/accept',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const request =
        await prisma.inspectionRequest.findUnique({
          where: {
            id: req.params.id,
          },
        });

      if (!request) {
        return res.status(404).json({
          error:
            'Request not found',
        });
      }

      if (
        request.status !==
          'REQUESTED' ||
        request.inspectorId
      ) {
        return res.status(400).json({
          error:
            `This request is already ${request.inspectorId ? 'assigned' : request.status.toLowerCase()} and cannot be accepted`,
        });
      }

      const claim =
        await prisma.inspectionRequest.updateMany({
          where: {
            id: req.params.id,
            status: 'REQUESTED',
            inspectorId: null,
          },

          data: {
            inspectorId:
              req.user.id,

            status:
              'ACCEPTED',
          },
        });

      if (
        claim.count === 0
      ) {
        return res.status(409).json({
          error:
            'This request was just claimed by another inspector',
        });
      }

      const updated =
        await prisma.inspectionRequest.findUnique({
          where: {
            id: req.params.id,
          },

          include:
            inspectionInclude,
        });

      res.json({
        request: updated,
      });
    } catch (error) {
      console.error(
        'ACCEPT INSPECTION ERROR:',
        error
      );

      res.status(500).json({
        error:
          'Could not accept inspection request',
      });
    }
  }
);


// ============================================================
// INSPECTION REPORT
// ============================================================

router.post(
  '/:id/report',
  authenticate,
  requireRole('INSPECTOR'),

  [
    body('quantity')
      .isFloat({ gt: 0 }),
  ],

  async (req, res) => {
    const errors =
      validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).json({
        errors:
          errors.array(),
      });
    }

    try {
      const request =
        await prisma.inspectionRequest.findUnique({
          where: {
            id: req.params.id,
          },
        });

      if (!request) {
        return res.status(404).json({
          error:
            'Request not found',
        });
      }

      if (
        request.inspectorId !==
        req.user.id
      ) {
        return res.status(403).json({
          error:
            'Only the assigned inspector can submit this report',
        });
      }

      if (
        request.status ===
        'COMPLETED'
      ) {
        return res.status(409).json({
          error:
            'Inspection is already completed',
        });
      }

      const {
        quantity,
        grade,
        moisture,
        visibleDefects,
        damageNotes,
        packagingNotes,
        photos,
        videos,
        gpsLocation,
      } = req.body;

      const report =
        await prisma.$transaction(
          async (tx) => {
            const created =
              await tx.inspectionReport.create({
                data: {
                  requestId:
                    request.id,

                  quantity:
                    Number(quantity),

                  grade:
                    grade ||
                    null,

                  moisture:
                    moisture ===
                      undefined ||
                    moisture === ''
                      ? null
                      : Number(
                          moisture
                        ),

                  visibleDefects:
                    visibleDefects ||
                    null,

                  damageNotes:
                    damageNotes ||
                    null,

                  packagingNotes:
                    packagingNotes ||
                    null,

                  photos:
                    Array.isArray(
                      photos
                    )
                      ? photos
                      : [],

                  videos:
                    Array.isArray(
                      videos
                    )
                      ? videos
                      : [],

                  gpsLocation:
                    gpsLocation ||
                    null,
                },
              });

            await tx.inspectionRequest.update({
              where: {
                id:
                  request.id,
              },

              data: {
                status:
                  'COMPLETED',
              },
            });

            return created;
          }
        );

      res.status(201).json({
        report,
      });
    } catch (error) {
      console.error(
        'INSPECTION REPORT ERROR:',
        error
      );

      res.status(500).json({
        error:
          'Could not submit inspection report',
      });
    }
  }
);


module.exports = router;
