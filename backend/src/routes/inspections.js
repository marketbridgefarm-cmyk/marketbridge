const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();

// Seller or buyer requests an inspection
router.post(
  '/',
  authenticate,
  requireRole('SELLER', 'BUYER'),
  [
    body('listingId').notEmpty(),
    body('mode').isIn(['SELLER_REQUESTED', 'BUYER_REQUESTED', 'JOINT']),
    body('fee').if(body('inspectorId').notEmpty()).isFloat({ gt: 0 }).withMessage('A fee is required when pre-selecting an inspector'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { listingId, mode, inspectorId, fee } = req.body;
      const listing = await prisma.listing.findUnique({ where: { id: listingId } });
      if (!listing) return res.status(404).json({ error: 'Listing not found' });

      if (inspectorId) {
        const inspector = await prisma.user.findUnique({ where: { id: inspectorId } });
        if (!inspector || !inspector.roles.includes('INSPECTOR')) {
          return res.status(400).json({ error: 'inspectorId does not belong to a registered inspector' });
        }
      }

      const request = await prisma.inspectionRequest.create({
        data: {
          listingId,
          requestedById: req.user.id,
          mode,
          inspectorId: inspectorId || null,
          location: listing.location,
          status: inspectorId ? 'ACCEPTED' : 'REQUESTED',
          fee: inspectorId ? Number(fee) : null,
        },
      });

      return res.status(201).json({ request });
    } catch (error) {
      console.error('CREATE INSPECTION REQUEST ERROR:', error);
      return res.status(500).json({ error: 'Could not create inspection request' });
    }
  }
);

// Farmers/buyers compare available inspectors
router.get('/inspectors', authenticate, async (req, res) => {
  try {
    const { location } = req.query;
    const inspectors = await prisma.user.findMany({
      where: {
        roles: { has: 'INSPECTOR' },
        ...(location && { location: { contains: location, mode: 'insensitive' } }),
      },
      select: { id: true, name: true, rating: true, location: true, verificationStatus: true },
    });

    return res.json({ inspectors });
  } catch (error) {
    console.error('GET INSPECTORS ERROR:', error);
    return res.status(500).json({ error: 'Could not load inspectors' });
  }
});

// Inspector browses open requests
router.get('/available', authenticate, requireRole('INSPECTOR'), async (req, res) => {
  try {
    const { location } = req.query;
    const requests = await prisma.inspectionRequest.findMany({
      where: {
        status: 'REQUESTED',
        inspectorId: null,
        ...(location && { location: { contains: location, mode: 'insensitive' } }),
      },
      include: {
        listing: { select: { id: true, cropType: true, quantity: true, unit: true, location: true, category: true } },
        requestedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ requests });
  } catch (error) {
    console.error('AVAILABLE INSPECTIONS ERROR:', error);
    return res.status(500).json({ error: 'Could not load available inspections' });
  }
});

// Inspector views their jobs
router.get('/mine', authenticate, requireRole('INSPECTOR'), async (req, res) => {
  try {
    const requests = await prisma.inspectionRequest.findMany({
      where: { inspectorId: req.user.id },
      include: {
        listing: { select: { id: true, cropType: true, quantity: true, unit: true, location: true, category: true } },
        requestedBy: { select: { id: true, name: true } },
        report: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ requests });
  } catch (error) {
    console.error('MY INSPECTIONS ERROR:', error);
    return res.status(500).json({ error: 'Could not load your inspections' });
  }
});

// Inspector accepts request
router.patch(
  '/:id/accept',
  authenticate,
  requireRole('INSPECTOR'),
  [body('fee').isFloat({ gt: 0 }).withMessage('A fee greater than zero is required to accept a request')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id } });
      if (!request) return res.status(404).json({ error: 'Request not found' });

      if (request.status !== 'REQUESTED' || request.inspectorId) {
        return res.status(400).json({ error: `This request is already ${request.inspectorId ? 'assigned' : request.status.toLowerCase()} and cannot be accepted` });
      }

      const claim = await prisma.inspectionRequest.updateMany({
        where: { id: req.params.id, status: 'REQUESTED', inspectorId: null },
        data: { inspectorId: req.user.id, status: 'ACCEPTED', fee: Number(req.body.fee) },
      });

      if (claim.count === 0) {
        return res.status(409).json({ error: 'This request was just claimed by another inspector' });
      }

      const updated = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id } });
      return res.json({ request: updated });
    } catch (error) {
      console.error('ACCEPT INSPECTION ERROR:', error);
      return res.status(500).json({ error: 'Could not accept inspection request' });
    }
  }
);

// Inspector starts an accepted inspection
router.post(
  '/:id/start',
  authenticate,
  requireRole('INSPECTOR'),
  async (req, res) => {
    try {
      const request = await prisma.inspectionRequest.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          inspectorId: true,
          status: true,
        },
      });

      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
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

      const started = await prisma.inspectionRequest.updateMany({
        where: {
          id: request.id,
          inspectorId: req.user.id,
          status: 'ACCEPTED',
        },
        data: { status: 'IN_PROGRESS' },
      });

      if (started.count === 0) {
        return res.status(409).json({
          error: 'This inspection was already started or its status changed',
        });
      }

      const updated = await prisma.inspectionRequest.findUnique({
        where: { id: request.id },
        include: {
          listing: {
            select: {
              id: true,
              cropType: true,
              quantity: true,
              unit: true,
              location: true,
              category: true,
            },
          },
          requestedBy: { select: { id: true, name: true } },
          inspector: {
            select: { id: true, name: true, location: true },
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
      return res.status(500).json({ error: 'Could not start inspection' });
    }
  }
);

// Inspector submits report
router.post(
  '/:id/report',
  authenticate,
  requireRole('INSPECTOR'),
  [body('quantity').isFloat({ gt: 0 })],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id } });
      if (!request) return res.status(404).json({ error: 'Request not found' });

      if (request.inspectorId !== req.user.id) {
        return res.status(403).json({ error: 'Only the assigned inspector can submit this report' });
      }

      if (request.status !== 'IN_PROGRESS') {
        return res.status(400).json({
          error: `Inspection must be IN_PROGRESS before submitting a report. Current status: ${request.status}`,
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

      const report = await prisma.inspectionReport.create({
        data: {
          requestId: request.id,
          quantity,
          grade,
          moisture,
          visibleDefects,
          damageNotes,
          packagingNotes,
          photos: photos || [],
          videos: videos || [],
          gpsLocation,
        },
      });

      await prisma.inspectionRequest.update({
        where: { id: request.id },
        data: { status: 'COMPLETED' },
      });

      return res.status(201).json({ report });
    } catch (error) {
      console.error('CREATE INSPECTION REPORT ERROR:', error);
      return res.status(500).json({ error: 'Could not submit inspection report' });
    }
  }
);

module.exports = router;
