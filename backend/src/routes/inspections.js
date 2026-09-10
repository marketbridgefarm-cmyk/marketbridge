const express = require('express');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { signedMediaUrl, privateMediaMetadata } = require('../utils/objectStorage');
const { evidenceUpload, uploadEvidenceFiles } = require('../utils/evidenceUpload');

const router = express.Router();

function validationError(res) {
  const errors = validationResult(res.req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  return null;
}

// ============================================================================
// CREATE INSPECTION REQUEST
// Seller or buyer requests an inspection.
// ============================================================================

router.post(
  '/',
  authenticate,
  requireRole('SELLER', 'BUYER'),
  [
    body('listingId').notEmpty(),
    body('mode')
      .isIn(['SELLER_REQUESTED', 'BUYER_REQUESTED', 'JOINT'])
      .withMessage('Invalid inspection mode'),
    body('inspectorId').optional({ nullable: true }).isString(),
    body('fee')
      .if(body('inspectorId').notEmpty())
      .isFloat({ gt: 0 })
      .withMessage('A fee is required when pre-selecting an inspector'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const {
        listingId,
        mode,
        inspectorId,
        fee,
      } = req.body;

      const listing = await prisma.listing.findUnique({
        where: { id: listingId },
      });

      if (!listing) {
        return res.status(404).json({
          error: 'Listing not found',
        });
      }

      if (listing.category !== 'AGRICULTURAL') {
        return res.status(400).json({
          error: 'Inspections are only available for agricultural listings',
        });
      }

      if (inspectorId) {
        const inspector = await prisma.user.findUnique({
          where: { id: inspectorId },
        });

        if (
          !inspector ||
          !inspector.roles.includes('INSPECTOR')
        ) {
          return res.status(400).json({
            error: 'inspectorId does not belong to a registered inspector',
          });
        }

        if (inspector.id === req.user.id) {
          return res.status(400).json({
            error: 'You cannot select yourself as the inspector',
          });
        }
      }

      const request = await prisma.$transaction(async (tx) => {
        const created = await tx.inspectionRequest.create({
          data: {
            listingId,
            requestedById: req.user.id,
            mode,
            // Preserve the location at the time the inspection was requested.
            location: listing.location || null,
            inspectorId: inspectorId || null,
            status: inspectorId ? 'ACCEPTED' : 'REQUESTED',
            fee: inspectorId ? Number(fee) : null,
          },
          include: {
            listing: {
              select: {
                id: true, cropType: true, title: true, quantity: true, unit: true,
                location: true, category: true,
              },
            },
            inspector: {
              select: { id: true, name: true, rating: true, location: true },
            },
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_REQUEST_CREATED',
          resourceType: 'InspectionRequest',
          resourceId: created.id,
          metadata: { listingId, mode, inspectorId: inspectorId || null },
        });

        return created;
      });

      return res.status(201).json({ request });
    } catch (error) {
      console.error('CREATE INSPECTION REQUEST ERROR:', error);

      return res.status(500).json({
        error: 'Could not create inspection request',
      });
    }
  }
);

// ============================================================================
// FIND INSPECTORS
// ============================================================================

router.get('/inspectors', authenticate, async (req, res) => {
  try {
    const { location } = req.query;

    const inspectors = await prisma.user.findMany({
      where: {
        roles: {
          has: 'INSPECTOR',
        },

        ...(location
          ? {
              location: {
                contains: location,
                mode: 'insensitive',
              },
            }
          : {}),
      },

      select: {
        id: true,
        name: true,
        rating: true,
        location: true,
        verificationStatus: true,
      },

      orderBy: [
        {
          rating: 'desc',
        },
        {
          name: 'asc',
        },
      ],
    });

    return res.json({ inspectors });
  } catch (error) {
    console.error('GET INSPECTORS ERROR:', error);

    return res.status(500).json({
      error: 'Could not load inspectors',
    });
  }
});

// ============================================================================
// AVAILABLE INSPECTION REQUESTS
// ============================================================================

router.get(
  '/available',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const { location } = req.query;

      const requests = await prisma.inspectionRequest.findMany({
        where: {
          status: 'REQUESTED',
          inspectorId: null,

          ...(location
            ? {
                location: {
                  contains: location,
                  mode: 'insensitive',
                },
              }
            : {}),
        },

        include: {
          listing: {
            select: {
              id: true,
              cropType: true,
              title: true,
              quantity: true,
              unit: true,
              location: true,
              category: true,
            },
          },

          requestedBy: {
            select: {
              id: true,
              name: true,
              rating: true,
            },
          },

          quotes: {
            where: {
              status: 'PENDING',
            },

            select: {
              id: true,
              inspectorId: true,
              amount: true,
              status: true,
              message: true,
              createdAt: true,
            },
          },
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

      return res.json({ requests });
    } catch (error) {
      console.error('AVAILABLE INSPECTIONS ERROR:', error);

      return res.status(500).json({
        error: 'Could not load available inspections',
      });
    }
  }
);

// ============================================================================
// INSPECTOR SUBMITS QUOTE
// ============================================================================

router.post(
  '/:id/quote',
  authenticate,
  requireRole('INSPECTOR'),
  [
    param('id').notEmpty(),

    body('amount')
      .isFloat({ gt: 0 })
      .withMessage('Quote amount must be greater than zero'),

    body('message')
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ max: 1000 })
      .withMessage('Quote message is too long'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          errors: errors.array(),
        });
      }

      const request = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },
      });

      if (!request) {
        return res.status(404).json({
          error: 'Inspection request not found',
        });
      }

      if (request.status !== 'REQUESTED') {
        return res.status(400).json({
          error: 'This inspection is no longer accepting quotes',
        });
      }

      if (request.requestedById === req.user.id) {
        return res.status(403).json({
          error: 'You cannot quote on your own inspection request',
        });
      }

      const existing = await prisma.inspectionQuote.findUnique({
        where: {
          inspectionRequestId_inspectorId: {
            inspectionRequestId: request.id,
            inspectorId: req.user.id,
          },
        },
      });

      if (existing) {
        return res.status(409).json({
          error: 'You have already submitted a quote for this inspection',
        });
      }

      const quote = await prisma.$transaction(async (tx) => {
        const created = await tx.inspectionQuote.create({
          data: {
            inspectionRequestId: request.id,
            inspectorId: req.user.id,
            amount: Number(req.body.amount),
            message: req.body.message || null,
            status: 'PENDING',
          },
          include: {
            inspector: {
              select: {
                id: true,
                name: true,
                rating: true,
                location: true,
                verificationStatus: true,
              },
            },
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_QUOTE_SUBMITTED',
          resourceType: 'InspectionQuote',
          resourceId: created.id,
          metadata: { inspectionRequestId: request.id, amount: created.amount },
        });

        return created;
      });

      return res.status(201).json({
        quote,
      });
    } catch (error) {
      console.error('CREATE INSPECTION QUOTE ERROR:', error);

      return res.status(500).json({
        error: 'Could not submit inspection quote',
      });
    }
  }
);

// ============================================================================
// VIEW QUOTES FOR AN INSPECTION
// Only the requester can view the quote marketplace.
// ============================================================================

router.get(
  '/:id/quotes',
  authenticate,
  async (req, res) => {
    try {
      const request = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },

        select: {
          id: true,
          requestedById: true,
        },
      });

      if (!request) {
        return res.status(404).json({
          error: 'Inspection request not found',
        });
      }

      if (
        request.requestedById !== req.user.id &&
        !req.user.roles.includes('ADMIN')
      ) {
        return res.status(403).json({
          error: 'Only the inspection requester can view quotes',
        });
      }

      const quotes = await prisma.inspectionQuote.findMany({
        where: {
          inspectionRequestId: request.id,
        },

        include: {
          inspector: {
            select: {
              id: true,
              name: true,
              rating: true,
              location: true,
              verificationStatus: true,
            },
          },
        },

        orderBy: [
          {
            status: 'asc',
          },
          {
            amount: 'asc',
          },
          {
            createdAt: 'asc',
          },
        ],
      });

      return res.json({
        quotes,
      });
    } catch (error) {
      console.error('GET INSPECTION QUOTES ERROR:', error);

      return res.status(500).json({
        error: 'Could not load inspection quotes',
      });
    }
  }
);

// ============================================================================
// ACCEPT INSPECTION QUOTE
// Requester selects one inspector.
// ============================================================================

router.patch(
  '/:id/quotes/:quoteId/accept',
  authenticate,
  async (req, res) => {
    try {
      const request = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },
      });

      if (!request) {
        return res.status(404).json({
          error: 'Inspection request not found',
        });
      }

      if (request.requestedById !== req.user.id) {
        return res.status(403).json({
          error: 'Only the inspection requester can accept a quote',
        });
      }

      if (request.status !== 'REQUESTED') {
        return res.status(400).json({
          error: 'This inspection is no longer accepting quotes',
        });
      }

      const quote = await prisma.inspectionQuote.findUnique({
        where: {
          id: req.params.quoteId,
        },
      });

      if (!quote || quote.inspectionRequestId !== request.id) {
        return res.status(404).json({
          error: 'Inspection quote not found',
        });
      }

      if (quote.status !== 'PENDING') {
        return res.status(400).json({
          error: 'This quote is no longer available',
        });
      }

      const result = await prisma.$transaction(async (tx) => {
        const claim = await tx.inspectionRequest.updateMany({
          where: {
            id: request.id,
            requestedById: req.user.id,
            status: 'REQUESTED',
            inspectorId: null,
          },

          data: {
            inspectorId: quote.inspectorId,
            fee: quote.amount,
            status: 'ACCEPTED',
          },
        });

        if (claim.count !== 1) {
          throw new Error('INSPECTION_ALREADY_CLAIMED');
        }

        await tx.inspectionQuote.updateMany({
          where: {
            inspectionRequestId: request.id,
            status: 'PENDING',
            id: {
              not: quote.id,
            },
          },

          data: {
            status: 'REJECTED',
          },
        });

        const acceptedQuote = await tx.inspectionQuote.update({
          where: {
            id: quote.id,
          },

          data: {
            status: 'ACCEPTED',
          },

          include: {
            inspector: {
              select: {
                id: true,
                name: true,
                rating: true,
                location: true,
              },
            },
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_QUOTE_ACCEPTED',
          resourceType: 'InspectionQuote',
          resourceId: acceptedQuote.id,
          metadata: { inspectionRequestId: request.id, inspectorId: acceptedQuote.inspectorId },
        });

        return acceptedQuote;
      });

      return res.json({
        message: 'Inspection quote accepted',
        quote: result,
      });
    } catch (error) {
      if (error.message === 'INSPECTION_ALREADY_CLAIMED') {
        return res.status(409).json({
          error: 'This inspection was already assigned to another inspector',
        });
      }

      console.error('ACCEPT INSPECTION QUOTE ERROR:', error);

      return res.status(500).json({
        error: 'Could not accept inspection quote',
      });
    }
  }
);

// ============================================================================
// BACKWARD-COMPATIBLE DIRECT ACCEPT
// Existing inspector workflow remains supported.
// ============================================================================

router.patch(
  '/:id/accept',
  authenticate,
  requireRole('INSPECTOR'),
  [
    body('fee')
      .isFloat({ gt: 0 })
      .withMessage('A fee greater than zero is required to accept a request'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          errors: errors.array(),
        });
      }

      const request = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },
      });

      if (!request) {
        return res.status(404).json({
          error: 'Request not found',
        });
      }

      if (
        request.status !== 'REQUESTED' ||
        request.inspectorId
      ) {
        return res.status(400).json({
          error: `This request is already ${
            request.inspectorId
              ? 'assigned'
              : request.status.toLowerCase()
          } and cannot be accepted`,
        });
      }

      const claim = await prisma.inspectionRequest.updateMany({
        where: {
          id: req.params.id,
          status: 'REQUESTED',
          inspectorId: null,
        },

        data: {
          inspectorId: req.user.id,
          status: 'ACCEPTED',
          fee: Number(req.body.fee),
        },
      });

      if (claim.count === 0) {
        return res.status(409).json({
          error: 'This request was just claimed by another inspector',
        });
      }

      await recordAuditEvent(prisma, {
        actorId: req.user.id,
        action: 'INSPECTION_ASSIGNED',
        resourceType: 'InspectionRequest',
        resourceId: req.params.id,
        metadata: { fee: Number(req.body.fee), inspectorId: req.user.id },
      });

      const updated = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },

        include: {
          listing: {
            select: {
              id: true,
              cropType: true,
              title: true,
              quantity: true,
              unit: true,
              location: true,
            },
          },

          requestedBy: {
            select: {
              id: true,
              name: true,
            },
          },

          inspector: {
            select: {
              id: true,
              name: true,
              rating: true,
              location: true,
            },
          },
        },
      });

      return res.json({
        request: updated,
      });
    } catch (error) {
      console.error('ACCEPT INSPECTION ERROR:', error);

      return res.status(500).json({
        error: 'Could not accept inspection request',
      });
    }
  }
);

// ============================================================================
// INSPECTOR STARTS INSPECTION
// ACCEPTED -> IN_PROGRESS
// ============================================================================

router.post(
  '/:id/start',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const request = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },
      });

      if (!request) {
        return res.status(404).json({
          error: 'Inspection request not found',
        });
      }

      if (request.inspectorId !== req.user.id) {
        return res.status(403).json({
          error: 'Only the assigned inspector can start this inspection',
        });
      }

      if (request.status !== 'ACCEPTED') {
        return res.status(400).json({
          error: `Only an accepted inspection can be started. Current status: ${request.status}`,
        });
      }

      const result = await prisma.$transaction(async (tx) => {
        const updatedCount = await tx.inspectionRequest.updateMany({
          where: {
            id: request.id,
            inspectorId: req.user.id,
            status: 'ACCEPTED',
          },
          data: { status: 'IN_PROGRESS' },
        });

        if (updatedCount.count !== 1) {
          return false;
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_STARTED',
          resourceType: 'InspectionRequest',
          resourceId: request.id,
        });

        return true;
      });

      if (!result) {
        return res.status(409).json({
          error: 'This inspection was already started or its status changed',
        });
      }

      const updated = await prisma.inspectionRequest.findUnique({
        where: {
          id: request.id,
        },

        include: {
          listing: {
            select: {
              id: true,
              cropType: true,
              title: true,
              quantity: true,
              unit: true,
              location: true,
              category: true,
            },
          },

          requestedBy: {
            select: {
              id: true,
              name: true,
            },
          },

          inspector: {
            select: {
              id: true,
              name: true,
              rating: true,
              location: true,
            },
          },

          report: true,
        },
      });

      return res.json({
        message: 'Inspection started',
        request: updated,
      });
    } catch (error) {
      console.error('START INSPECTION ERROR:', error);

      return res.status(500).json({
        error: 'Could not start inspection',
      });
    }
  }
);

// ============================================================================
// INSPECTOR VIEWS THEIR JOBS
// ============================================================================

router.get(
  '/mine',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const requests = await prisma.inspectionRequest.findMany({
        where: {
          inspectorId: req.user.id,
        },

        include: {
          listing: {
            select: {
              id: true,
              cropType: true,
              title: true,
              quantity: true,
              unit: true,
              location: true,
              category: true,
            },
          },

          requestedBy: {
            select: {
              id: true,
              name: true,
              rating: true,
            },
          },

          report: true,
        },

        orderBy: {
          createdAt: 'desc',
        },
      });

      return res.json({
        requests,
      });
    } catch (error) {
      console.error('MY INSPECTIONS ERROR:', error);

      return res.status(500).json({
        error: 'Could not load your inspections',
      });
    }
  }
);

// ============================================================================
// INSPECTION EVIDENCE ACCESS
// Evidence is private transaction data. Only the inspection requester,
// listing seller, assigned inspector, or ADMIN may access it.
// ============================================================================

async function canAccessInspection(req, requestId) {
  const request = await prisma.inspectionRequest.findUnique({
    where: { id: requestId },
    include: { listing: { select: { sellerId: true } }, report: true },
  });
  if (!request) return { request: null, allowed: false };
  const allowed = req.user.roles.includes('ADMIN') ||
    request.requestedById === req.user.id ||
    request.inspectorId === req.user.id ||
    request.listing.sellerId === req.user.id;
  return { request, allowed };
}

router.get('/:id/evidence', authenticate, async (req, res) => {
  try {
    const access = await canAccessInspection(req, req.params.id);
    if (!access.request) return res.status(404).json({ error: 'Inspection request not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You are not authorized to access this inspection evidence' });
    if (!access.request.report) return res.json({ evidence: [] });
    const evidence = await prisma.inspectionEvidence.findMany({
      where: { reportId: access.request.report.id },
      select: { id: true, reportId: true, type: true, photos: true, videos: true, gpsLocation: true, notes: true, capturedAt: true, createdById: true },
      orderBy: { capturedAt: 'asc' },
    });
    return res.json({ evidence });
  } catch (error) {
    console.error('GET INSPECTION EVIDENCE ERROR:', error);
    return res.status(500).json({ error: 'Could not load inspection evidence' });
  }
});

router.get('/:id/evidence/:evidenceId/media', authenticate, [
  param('id').notEmpty(),
  param('evidenceId').notEmpty(),
], async (req, res) => {
  try {
    const access = await canAccessInspection(req, req.params.id);
    if (!access.request) return res.status(404).json({ error: 'Inspection request not found' });
    if (!access.allowed) return res.status(403).json({ error: 'You are not authorized to access this inspection evidence' });

    const evidence = await prisma.inspectionEvidence.findFirst({
      where: { id: req.params.evidenceId, reportId: access.request.report?.id || '__none__' },
    });
    if (!evidence) return res.status(404).json({ error: 'Inspection evidence not found' });

    const sign = async (ref, kind, index) => {
      const metadata = await privateMediaMetadata(ref);
      const url = await signedMediaUrl({
        key: metadata.key,
        fileName: `${kind.toLowerCase()}-${evidence.id}-${index + 1}`,
        contentType: metadata.contentType || undefined,
      });
      return { index, url, key: metadata.key, contentType: metadata.contentType, size: metadata.contentLength, etag: metadata.etag, lastModified: metadata.lastModified };
    };

    const media = { photos: [], videos: [], unsupported: [] };
    for (let i = 0; i < evidence.photos.length; i += 1) {
      try { media.photos.push(await sign(evidence.photos[i], 'photo', i)); }
      catch (error) { media.unsupported.push({ kind: 'photo', index: i, reason: error.message }); }
    }
    for (let i = 0; i < evidence.videos.length; i += 1) {
      try { media.videos.push(await sign(evidence.videos[i], 'video', i)); }
      catch (error) { media.unsupported.push({ kind: 'video', index: i, reason: error.message }); }
    }

    await prisma.auditEvent.create({
      data: {
        actorId: req.user.id,
        action: 'INSPECTION_EVIDENCE_MEDIA_ACCESSED',
        resourceType: 'InspectionEvidence',
        resourceId: evidence.id,
        metadata: { inspectionRequestId: access.request.id, photoCount: media.photos.length, videoCount: media.videos.length, unsupportedCount: media.unsupported.length },
      },
    });

    return res.json({ evidenceId: evidence.id, expiresInSeconds: Math.min(Math.max(Number(process.env.MEDIA_SIGNED_URL_EXPIRES_SECONDS || 300), 60), 900), media });
  } catch (error) {
    console.error('SIGN INSPECTION EVIDENCE MEDIA ERROR:', error);
    return res.status(503).json({ error: 'Protected media is temporarily unavailable' });
  }
});

// ============================================================================
// UPLOAD INSPECTION EVIDENCE MEDIA
// Returns private object-storage keys for use in POST /:id/report or
// POST /:id/evidence. Only the assigned inspector may upload.
// ============================================================================

router.post('/:id/evidence/media', authenticate, requireRole('INSPECTOR'), evidenceUpload.array('files', 5), async (req, res) => {
  try {
    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (request.inspectorId !== req.user.id) return res.status(403).json({ error: 'Only the assigned inspector can add inspection evidence' });
    if (!req.files?.length) return res.status(400).json({ error: 'At least one file is required' });

    const { photoKeys, videoKeys } = await uploadEvidenceFiles('inspection', request.id, req.files);

    return res.status(201).json({ photoKeys, videoKeys });
  } catch (error) {
    console.error('UPLOAD INSPECTION EVIDENCE MEDIA ERROR:', error);
    return res.status(500).json({ error: error.message || 'Could not upload evidence media' });
  }
});

router.post('/:id/evidence', authenticate, requireRole('INSPECTOR'), [
  param('id').notEmpty(),
  body('photos').optional().isArray().withMessage('photos must be an array'),
  body('videos').optional().isArray().withMessage('videos must be an array'),
  body('gpsLocation').optional({ nullable: true }).isString(),
  body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
  body('capturedAt').optional({ nullable: true }).isISO8601().withMessage('capturedAt must be a valid ISO date'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id }, include: { report: true } });
    if (!request) return res.status(404).json({ error: 'Inspection request not found' });
    if (request.inspectorId !== req.user.id) return res.status(403).json({ error: 'Only the assigned inspector can add inspection evidence' });
    if (!request.report) return res.status(400).json({ error: 'Submit the inspection report before adding supplemental evidence' });
    const photos = Array.isArray(req.body.photos) ? req.body.photos : [];
    const videos = Array.isArray(req.body.videos) ? req.body.videos : [];
    const gpsLocation = req.body.gpsLocation || null;
    const notes = req.body.notes || null;
    if (!photos.length && !videos.length && !gpsLocation && !notes) return res.status(400).json({ error: 'Evidence must contain a photo, video, GPS location, or notes' });
    const evidence = await prisma.$transaction(async (tx) => {
      const created = await tx.inspectionEvidence.create({
        data: { reportId: request.report.id, type: 'ADDITIONAL', photos, videos, gpsLocation, notes, capturedAt: req.body.capturedAt ? new Date(req.body.capturedAt) : new Date(), createdById: req.user.id },
      });
      await recordAuditEvent(tx, { actorId: req.user.id, action: 'INSPECTION_EVIDENCE_ADDED', resourceType: 'InspectionEvidence', resourceId: created.id, metadata: { inspectionRequestId: request.id, reportId: request.report.id, type: created.type } });
      return created;
    });
    return res.status(201).json({ evidence });
  } catch (error) {
    console.error('ADD INSPECTION EVIDENCE ERROR:', error);
    return res.status(500).json({ error: 'Could not add inspection evidence' });
  }
});

// ============================================================================
// SUBMIT INSPECTION REPORT
// IN_PROGRESS -> COMPLETED
// ============================================================================

router.post(
  '/:id/report',
  authenticate,
  requireRole('INSPECTOR'),
  [
    body('quantity')
      .isFloat({ gt: 0 })
      .withMessage('Verified quantity must be greater than zero'),

    body('grade')
      .optional({ nullable: true })
      .isString(),

    body('moisture')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage('moisture must be zero or greater'),

    body('visibleDefects')
      .optional({ nullable: true })
      .isString(),

    body('damageNotes')
      .optional({ nullable: true })
      .isString(),

    body('packagingNotes')
      .optional({ nullable: true })
      .isString(),

    body('gpsLocation')
      .optional({ nullable: true })
      .isString(),

    body('photos')
      .optional()
      .isArray()
      .withMessage('photos must be an array'),

    body('videos')
      .optional()
      .isArray()
      .withMessage('videos must be an array'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          errors: errors.array(),
        });
      }

      const request = await prisma.inspectionRequest.findUnique({
        where: {
          id: req.params.id,
        },

        include: {
          report: true,
        },
      });

      if (!request) {
        return res.status(404).json({
          error: 'Request not found',
        });
      }

      if (request.inspectorId !== req.user.id) {
        return res.status(403).json({
          error: 'Only the assigned inspector can submit this report',
        });
      }

      if (request.status !== 'IN_PROGRESS') {
        return res.status(400).json({
          error: `Inspection must be IN_PROGRESS before submitting a report. Current status: ${request.status}`,
        });
      }

      if (request.report) {
        return res.status(409).json({
          error: 'An inspection report has already been submitted',
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

      const report = await prisma.$transaction(async (tx) => {
        const createdReport = await tx.inspectionReport.create({
          data: {
            requestId: request.id,
            quantity: Number(quantity),
            grade: grade || null,
            moisture:
              moisture !== undefined &&
              moisture !== null &&
              moisture !== ''
                ? Number(moisture)
                : null,
            visibleDefects: visibleDefects || null,
            damageNotes: damageNotes || null,
            packagingNotes: packagingNotes || null,
            photos: Array.isArray(photos) ? photos : [],
            videos: Array.isArray(videos) ? videos : [],
            gpsLocation: gpsLocation || null,
          },
        });

        await tx.inspectionEvidence.create({
          data: {
            reportId: createdReport.id,
            type: 'REPORT',
            photos: Array.isArray(photos) ? photos : [],
            videos: Array.isArray(videos) ? videos : [],
            gpsLocation: gpsLocation || null,
            notes: [visibleDefects, damageNotes, packagingNotes].filter(Boolean).join('\n') || null,
            capturedAt: createdReport.inspectedAt,
            createdById: req.user.id,
          },
        });

        const completed = await tx.inspectionRequest.updateMany({
          where: {
            id: request.id,
            inspectorId: req.user.id,
            status: 'IN_PROGRESS',
          },

          data: {
            status: 'COMPLETED',
          },
        });

        if (completed.count !== 1) {
          throw new Error('INSPECTION_STATUS_CHANGED');
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'INSPECTION_REPORT_SUBMITTED',
          resourceType: 'InspectionReport',
          resourceId: createdReport.id,
          metadata: { inspectionRequestId: request.id, quantity: createdReport.quantity },
        });

        return createdReport;
      });

      return res.status(201).json({
        report,
      });
    } catch (error) {
      if (error.message === 'INSPECTION_STATUS_CHANGED') {
        return res.status(409).json({
          error: 'Inspection status changed before the report could be completed',
        });
      }

      console.error('CREATE INSPECTION REPORT ERROR:', error);

      return res.status(500).json({
        error: 'Could not submit inspection report',
      });
    }
  }
);

module.exports = router;






