'use strict';

// Admin queue for disputed inspector arrivals. Mounted at
// /api/admin/inspection-arrivals (see src/index.js). The admin sees the
// inspector's GPS fix, distance from the listing, photo and the seller's
// closed-reason dispute, then rules ARRIVED or NO_SHOW.

const express = require('express');
const { body, query, validationResult } = require('express-validator');

const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole, requireMfa } = require('../middleware/roleCheck');
const { recordAuditEvent } = require('../utils/audit');
const { signedMediaUrl, privateMediaMetadata } = require('../utils/objectStorage');
const arrival = require('../services/inspectionArrivalService');

const router = express.Router();
const STATUSES = ['PENDING_SELLER', 'CONFIRMED', 'AUTO_CONFIRMED', 'DISPUTED', 'RESOLVED_ARRIVED', 'RESOLVED_NO_SHOW'];

function sendError(req, res, error, label) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  req.log.error({ err: error }, label);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

router.get(
  '/',
  authenticate,
  requireRole('ADMIN'),
  [query('status').optional().isIn(STATUSES)],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid status filter' });
    try {
      const arrivals = await arrival.adminListArrivals(prisma, { status: req.query.status || 'DISPUTED' });
      return res.json({ arrivals, count: arrivals.length });
    } catch (error) {
      return sendError(req, res, error, 'ADMIN ARRIVALS LIST ERROR');
    }
  }
);

router.get('/:id/photo', authenticate, requireRole('ADMIN'), async (req, res) => {
  try {
    const record = await prisma.inspectionArrival.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ error: 'Arrival record not found' });
    const photos = [];
    for (let i = 0; i < record.photoKeys.length; i += 1) {
      const metadata = await privateMediaMetadata(record.photoKeys[i]);
      photos.push({ index: i, url: await signedMediaUrl({ key: metadata.key, fileName: `arrival-${record.id}-${i + 1}`, contentType: metadata.contentType || undefined }) });
    }
    await recordAuditEvent(prisma, { actorId: req.user.id, action: 'INSPECTION_ARRIVAL_PHOTO_ACCESSED', resourceType: 'InspectionArrival', resourceId: record.id, metadata: { count: photos.length, admin: true } });
    return res.json({ photos });
  } catch (error) {
    req.log.error({ err: error }, 'ADMIN ARRIVAL PHOTO ERROR');
    return res.status(503).json({ error: 'Protected media is temporarily unavailable' });
  }
});

router.post(
  '/:id/resolve',
  authenticate,
  requireRole('ADMIN'),
  requireMfa(),
  [
    body('outcome').isIn(['ARRIVED', 'NO_SHOW']).withMessage('Outcome must be ARRIVED or NO_SHOW'),
    body('note').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
      const result = await arrival.adminResolve(prisma, {
        arrivalId: req.params.id,
        adminId: req.user.id,
        outcome: req.body.outcome,
        note: req.body.note,
      });
      return res.json({
        message: result.outcome === 'ARRIVED'
          ? 'Ruled: the inspector was on site. The inspection fee can now be paid.'
          : 'Ruled: no-show. Bidding is reopened and a standing penalty was applied to the inspector.',
        ...result,
      });
    } catch (error) {
      return sendError(req, res, error, 'ADMIN ARRIVAL RESOLVE ERROR');
    }
  }
);

module.exports = router;
