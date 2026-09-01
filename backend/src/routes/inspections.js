const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();

// Seller or buyer requests an inspection (joint also allowed)
router.post(
  '/',
  authenticate,
  requireRole('SELLER', 'BUYER'),
  [body('listingId').notEmpty(), body('mode').isIn(['SELLER_REQUESTED', 'BUYER_REQUESTED', 'JOINT'])],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { listingId, mode, inspectorId } = req.body;
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    // If the requester pre-selected an inspector, confirm that account is
    // actually an inspector before honoring it (and auto-accepting).
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
        status: inspectorId ? 'ACCEPTED' : 'REQUESTED',
      },
    });

    res.status(201).json({ request });
  }
);

// Farmers/buyers compare available inspectors
router.get('/inspectors', authenticate, async (req, res) => {
  const { location } = req.query;
  const inspectors = await prisma.user.findMany({
    where: {
      roles: { has: 'INSPECTOR' },
      ...(location && { location: { contains: location, mode: 'insensitive' } }),
    },
    select: { id: true, name: true, rating: true, location: true, verificationStatus: true },
  });
  res.json({ inspectors });
});

// Inspector accepts a pending request
router.patch('/:id/accept', authenticate, requireRole('INSPECTOR'), async (req, res) => {
  const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'REQUESTED' || request.inspectorId) {
    return res.status(400).json({ error: `This request is already ${request.inspectorId ? 'assigned' : request.status.toLowerCase()} and cannot be accepted` });
  }

  // Atomic claim: only succeeds if the request is still unassigned, so two
  // inspectors racing to accept the same request can't both win.
  const claim = await prisma.inspectionRequest.updateMany({
    where: { id: req.params.id, status: 'REQUESTED', inspectorId: null },
    data: { inspectorId: req.user.id, status: 'ACCEPTED' },
  });
  if (claim.count === 0) {
    return res.status(409).json({ error: 'This request was just claimed by another inspector' });
  }

  const updated = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id } });
  res.json({ request: updated });
});

// Inspector submits evidence/report — inspectors verify only, never arrange transport
router.post(
  '/:id/report',
  authenticate,
  requireRole('INSPECTOR'),
  [body('quantity').isFloat({ gt: 0 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const request = await prisma.inspectionRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.inspectorId !== req.user.id) {
      return res.status(403).json({ error: 'Only the assigned inspector can submit this report' });
    }

    const {
      quantity, grade, moisture, visibleDefects, damageNotes, packagingNotes, photos, videos, gpsLocation,
    } = req.body;

    const report = await prisma.inspectionReport.create({
      data: {
        requestId: request.id,
        quantity, grade, moisture, visibleDefects, damageNotes, packagingNotes,
        photos: photos || [],
        videos: videos || [],
        gpsLocation,
      },
    });

    await prisma.inspectionRequest.update({ where: { id: request.id }, data: { status: 'COMPLETED' } });

    res.status(201).json({ report });
  }
);

module.exports = router;
