'use strict';

const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /notices?limit=50
// Returns the union of offer / inspection / transport waiting-list notices
// for the authenticated user, newest first. `unreadCount` covers all three.
router.get('/', authenticate, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

    const [offers, inspections, transports] = await Promise.all([
      prisma.offerNotification.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.inspectionNotification.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.transportNotification.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);

    const tagged = [
      ...offers.map((n) => ({
        id: n.id,
        scope: 'OFFER',
        scopeId: n.listingId,
        bidId: n.offerId,
        type: n.type,
        title: n.title,
        body: n.body,
        metadata: n.metadata,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      ...inspections.map((n) => ({
        id: n.id,
        scope: 'INSPECTION',
        scopeId: n.inspectionRequestId,
        bidId: n.quoteId,
        type: n.type,
        title: n.title,
        body: n.body,
        metadata: n.metadata,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      ...transports.map((n) => ({
        id: n.id,
        scope: 'TRANSPORT',
        scopeId: n.transportJobId,
        bidId: n.quoteId,
        type: n.type,
        title: n.title,
        body: n.body,
        metadata: n.metadata,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
    ]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);

    const unreadCount =
      (await prisma.offerNotification.count({ where: { userId: req.user.id, readAt: null } })) +
      (await prisma.inspectionNotification.count({ where: { userId: req.user.id, readAt: null } })) +
      (await prisma.transportNotification.count({ where: { userId: req.user.id, readAt: null } }));

    return res.json({ notices: tagged, unreadCount });
  } catch (error) {
    req.log.error({ err: error }, 'LIST NOTICES ERROR');
    return res.status(500).json({ error: 'Could not load notices' });
  }
});

// PATCH /notices/read-all
// Marks every waiting-list notice as read across all three scopes.
router.patch('/read-all', authenticate, async (req, res) => {
  try {
    const now = new Date();
    await Promise.all([
      prisma.offerNotification.updateMany({
        where: { userId: req.user.id, readAt: null },
        data: { readAt: now },
      }),
      prisma.inspectionNotification.updateMany({
        where: { userId: req.user.id, readAt: null },
        data: { readAt: now },
      }),
      prisma.transportNotification.updateMany({
        where: { userId: req.user.id, readAt: null },
        data: { readAt: now },
      }),
    ]);
    return res.json({ ok: true });
  } catch (error) {
    req.log.error({ err: error }, 'READ ALL NOTICES ERROR');
    return res.status(500).json({ error: 'Could not update notices' });
  }
});

// PATCH /notices/:scope/:id/read
// Mark one notice read. Scope is OFFER | INSPECTION | TRANSPORT.
router.patch('/:scope/:id/read', authenticate, async (req, res) => {
  try {
    const scope = String(req.params.scope || '').toUpperCase();
    const model =
      scope === 'OFFER' ? prisma.offerNotification
      : scope === 'INSPECTION' ? prisma.inspectionNotification
      : scope === 'TRANSPORT' ? prisma.transportNotification
      : null;
    if (!model) return res.status(400).json({ error: 'Unknown notice scope' });

    await model.updateMany({
      where: { id: req.params.id, userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ ok: true });
  } catch (error) {
    req.log.error({ err: error }, 'READ NOTICE ERROR');
    return res.status(500).json({ error: 'Could not update notice' });
  }
});

module.exports = router;
