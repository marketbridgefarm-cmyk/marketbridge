'use strict';

const express = require('express');
const { param, query, body, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { listNotifications } = require('../services/notificationService');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  }
  next();
}

// ============================================================================
// HELPERS — one unified shape for all three notification tables
// ============================================================================

function shapeOrderNotification(row) {
  return {
    id: row.id,
    scope: 'ORDER',
    type: row.type,
    title: row.title,
    body: row.body,
    readAt: row.readAt,
    createdAt: row.createdAt,
    orderId: row.orderId,
    orderEventId: row.orderEventId,
    action: row.action,
    metadata: row.metadata,
  };
}

function shapeInspectionNotification(row) {
  return {
    id: row.id,
    scope: 'INSPECTION',
    type: row.type,
    title: row.title,
    body: row.body,
    readAt: row.readAt,
    createdAt: row.createdAt,
    inspectionRequestId: row.inspectionRequestId,
    quoteId: row.quoteId,
    metadata: row.metadata,
  };
}

function shapeTransportNotification(row) {
  return {
    id: row.id,
    scope: 'TRANSPORT',
    type: row.type,
    title: row.title,
    body: row.body,
    readAt: row.readAt,
    createdAt: row.createdAt,
    transportJobId: row.transportJobId,
    quoteId: row.quoteId,
    metadata: row.metadata,
  };
}

// ============================================================================
// LIST — merges all three sources into one timeline
// ============================================================================

router.get(
  '/',
  authenticate,
  [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('unreadOnly').optional().isBoolean(),
    query('scope').optional().isIn(['ORDER', 'INSPECTION', 'TRANSPORT', 'ALL']),
  ],
  validate,
  async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const unreadOnly = req.query.unreadOnly === 'true';
      const scope = req.query.scope || 'ALL';

      const wantOrder       = scope === 'ALL' || scope === 'ORDER';
      const wantInspection  = scope === 'ALL' || scope === 'INSPECTION';
      const wantTransport   = scope === 'ALL' || scope === 'TRANSPORT';

      const [order, inspection, transport] = await Promise.all([
        wantOrder
          ? prisma.notification.findMany({
              where: { userId: req.user.id, ...(unreadOnly ? { readAt: null } : {}) },
              orderBy: { createdAt: 'desc' },
              take: limit,
            })
          : [],
        wantInspection
          ? prisma.inspectionNotification.findMany({
              where: { userId: req.user.id, ...(unreadOnly ? { readAt: null } : {}) },
              orderBy: { createdAt: 'desc' },
              take: limit,
            })
          : [],
        wantTransport
          ? prisma.transportNotification.findMany({
              where: { userId: req.user.id, ...(unreadOnly ? { readAt: null } : {}) },
              orderBy: { createdAt: 'desc' },
              take: limit,
            })
          : [],
      ]);

      const merged = [
        ...order.map(shapeOrderNotification),
        ...inspection.map(shapeInspectionNotification),
        ...transport.map(shapeTransportNotification),
      ]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);

      const [orderUnread, inspectionUnread, transportUnread] = await Promise.all([
        prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
        prisma.inspectionNotification.count({ where: { userId: req.user.id, readAt: null } }),
        prisma.transportNotification.count({ where: { userId: req.user.id, readAt: null } }),
      ]);

      return res.json({
        notifications: merged,
        unreadCount: orderUnread + inspectionUnread + transportUnread,
        counts: {
          order: orderUnread,
          inspection: inspectionUnread,
          transport: transportUnread,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'LIST NOTIFICATIONS ERROR:');
      return res.status(500).json({ error: 'Could not load notifications' });
    }
  }
);

// ============================================================================
// UNREAD COUNT — cheap endpoint for the tab badge
// ============================================================================

router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const [orderUnread, inspectionUnread, transportUnread] = await Promise.all([
      prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
      prisma.inspectionNotification.count({ where: { userId: req.user.id, readAt: null } }),
      prisma.transportNotification.count({ where: { userId: req.user.id, readAt: null } }),
    ]);

    return res.json({
      unreadCount: orderUnread + inspectionUnread + transportUnread,
      counts: {
        order: orderUnread,
        inspection: inspectionUnread,
        transport: transportUnread,
      },
    });
  } catch (error) {
    req.log.error({ err: error }, 'UNREAD NOTIFICATION COUNT ERROR:');
    return res.status(500).json({ error: 'Could not load notification count' });
  }
});

// ============================================================================
// MARK ONE READ — scope in the body routes to the correct table
// ============================================================================

router.patch(
  '/:id/read',
  authenticate,
  [
    param('id').isUUID(),
    body('scope').optional().isIn(['ORDER', 'INSPECTION', 'TRANSPORT']),
  ],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const scope = req.body.scope;

      // Preferred path: frontend tells us which table. One exact update.
      if (scope) {
        const table =
          scope === 'ORDER' ? prisma.notification :
          scope === 'INSPECTION' ? prisma.inspectionNotification :
          prisma.transportNotification;

        const result = await table.updateMany({
          where: { id, userId: req.user.id, readAt: null },
          data: { readAt: new Date() },
        });

        if (result.count > 0) {
          return res.json({ success: true, notificationId: id, scope });
        }

        // Already read — confirm it exists, then succeed (idempotent).
        const existing = await table.findFirst({
          where: { id, userId: req.user.id },
          select: { id: true },
        });
        if (existing) return res.json({ success: true, notificationId: id, scope, alreadyRead: true });

        return res.status(404).json({ error: 'Notification not found' });
      }

      // Fallback: no scope given, try all three (older clients).
      const orderResult = await prisma.notification.updateMany({
        where: { id, userId: req.user.id, readAt: null },
        data: { readAt: new Date() },
      });
      if (orderResult.count > 0) {
        return res.json({ success: true, notificationId: id, scope: 'ORDER' });
      }

      const inspectionResult = await prisma.inspectionNotification.updateMany({
        where: { id, userId: req.user.id, readAt: null },
        data: { readAt: new Date() },
      });
      if (inspectionResult.count > 0) {
        return res.json({ success: true, notificationId: id, scope: 'INSPECTION' });
      }

      const transportResult = await prisma.transportNotification.updateMany({
        where: { id, userId: req.user.id, readAt: null },
        data: { readAt: new Date() },
      });
      if (transportResult.count > 0) {
        return res.json({ success: true, notificationId: id, scope: 'TRANSPORT' });
      }

      // None updated. Check if it exists at all (already read or unknown).
      const existing =
        (await prisma.notification.findFirst({ where: { id, userId: req.user.id }, select: { id: true } })) ||
        (await prisma.inspectionNotification.findFirst({ where: { id, userId: req.user.id }, select: { id: true } })) ||
        (await prisma.transportNotification.findFirst({ where: { id, userId: req.user.id }, select: { id: true } }));

      if (!existing) return res.status(404).json({ error: 'Notification not found' });
      return res.json({ success: true, notificationId: id, alreadyRead: true });
    } catch (error) {
      req.log.error({ err: error }, 'MARK NOTIFICATION READ ERROR:');
      return res.status(500).json({ error: 'Could not mark notification as read' });
    }
  }
);

// ============================================================================
// MARK ONE UNREAD
// ============================================================================

router.patch(
  '/:id/unread',
  authenticate,
  [
    param('id').isUUID(),
    body('scope').optional().isIn(['ORDER', 'INSPECTION', 'TRANSPORT']),
  ],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const scope = req.body.scope;

      const candidates = scope
        ? [scope === 'ORDER' ? prisma.notification :
           scope === 'INSPECTION' ? prisma.inspectionNotification :
           prisma.transportNotification]
        : [prisma.notification, prisma.inspectionNotification, prisma.transportNotification];

      for (const table of candidates) {
        const result = await table.updateMany({
          where: { id, userId: req.user.id },
          data: { readAt: null },
        });
        if (result.count > 0) {
          return res.json({ success: true, notificationId: id, scope });
        }
      }

      return res.status(404).json({ error: 'Notification not found' });
    } catch (error) {
      req.log.error({ err: error }, 'MARK NOTIFICATION UNREAD ERROR:');
      return res.status(500).json({ error: 'Could not mark notification as unread' });
    }
  }
);

// ============================================================================
// MARK ALL READ — across all three tables
// ============================================================================

router.post('/read-all', authenticate, async (req, res) => {
  try {
    const scope = req.body?.scope;
    const now = new Date();

    const orderTables =
      (!scope || scope === 'ORDER') ? [prisma.notification] : [];
    const inspectionTables =
      (!scope || scope === 'INSPECTION') ? [prisma.inspectionNotification] : [];
    const transportTables =
      (!scope || scope === 'TRANSPORT') ? [prisma.transportNotification] : [];

    const results = await Promise.all([
      ...orderTables.map((t) => t.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: now } })),
      ...inspectionTables.map((t) => t.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: now } })),
      ...transportTables.map((t) => t.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: now } })),
    ]);

    const markedRead = results.reduce((sum, r) => sum + r.count, 0);
    return res.json({ success: true, markedRead });
  } catch (error) {
    req.log.error({ err: error }, 'MARK ALL NOTIFICATIONS READ ERROR:');
    return res.status(500).json({ error: 'Could not mark notifications as read' });
  }
});

module.exports = router;
