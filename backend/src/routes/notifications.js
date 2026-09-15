'use strict';

const express = require('express');
const { param, query, validationResult } = require('express-validator');
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

router.get(
  '/',
  authenticate,
  [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('unreadOnly').optional().isBoolean(),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await listNotifications(prisma, req.user.id, {
        limit: req.query.limit,
        unreadOnly: req.query.unreadOnly === 'true',
      });

      return res.json(result);
    } catch (error) {
      req.log.error({ err: error }, 'LIST NOTIFICATIONS ERROR:');
      return res.status(500).json({ error: 'Could not load notifications' });
    }
  }
);

router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const unreadCount = await prisma.notification.count({
      where: { userId: req.user.id, readAt: null },
    });

    return res.json({ unreadCount });
  } catch (error) {
    req.log.error({ err: error }, 'UNREAD NOTIFICATION COUNT ERROR:');
    return res.status(500).json({ error: 'Could not load notification count' });
  }
});

router.patch(
  '/:id/read',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const notification = await prisma.notification.updateMany({
        where: {
          id: req.params.id,
          userId: req.user.id,
          readAt: null,
        },
        data: { readAt: new Date() },
      });

      if (notification.count === 0) {
        const existing = await prisma.notification.findFirst({
          where: { id: req.params.id, userId: req.user.id },
          select: { id: true },
        });
        if (!existing) return res.status(404).json({ error: 'Notification not found' });
      }

      return res.json({ success: true, notificationId: req.params.id });
    } catch (error) {
      req.log.error({ err: error }, 'MARK NOTIFICATION READ ERROR:');
      return res.status(500).json({ error: 'Could not mark notification as read' });
    }
  }
);

router.patch(
  '/:id/unread',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await prisma.notification.updateMany({
        where: { id: req.params.id, userId: req.user.id },
        data: { readAt: null },
      });
      if (result.count === 0) return res.status(404).json({ error: 'Notification not found' });
      return res.json({ success: true, notificationId: req.params.id });
    } catch (error) {
      req.log.error({ err: error }, 'MARK NOTIFICATION UNREAD ERROR:');
      return res.status(500).json({ error: 'Could not mark notification as unread' });
    }
  }
);

router.post('/read-all', authenticate, async (req, res) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });

    return res.json({ success: true, markedRead: result.count });
  } catch (error) {
    req.log.error({ err: error }, 'MARK ALL NOTIFICATIONS READ ERROR:');
    return res.status(500).json({ error: 'Could not mark notifications as read' });
  }
});

module.exports = router;
