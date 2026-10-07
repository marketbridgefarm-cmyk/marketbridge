'use strict';

const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const standing = require('../services/providerStandingService');

const router = express.Router();

function isProvider(user) {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  return roles.includes('TRUCK_OWNER') || roles.includes('INSPECTOR');
}

function sendError(req, res, error, fallback) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  req.log.error({ err: error }, fallback);
  return res.status(500).json({ error: fallback });
}

// Current standing (strikes, suspension/probation dates, rating penalty).
router.get('/me', authenticate, async (req, res) => {
  try {
    if (!isProvider(req.user)) return res.json({ standing: null });
    return res.json({ standing: await standing.getStandingSummary(prisma, req.user.id) });
  } catch (error) {
    return sendError(req, res, error, 'Could not load provider standing');
  }
});

// After a suspension ends the provider acknowledges the rules to rejoin on probation.
router.post('/me/rejoin', authenticate, async (req, res) => {
  try {
    if (req.body?.acknowledged !== true) {
      return res.status(400).json({ error: 'Please acknowledge the marketplace rules to rejoin.', code: 'ACK_REQUIRED' });
    }
    await standing.rejoin(prisma, req.user.id);
    return res.json({
      message: `Welcome back. You are on probation for ${standing.PROBATION_DAYS} days: cancelling an accepted agreement during this time suspends you again.`,
      standing: await standing.getStandingSummary(prisma, req.user.id),
    });
  } catch (error) {
    return sendError(req, res, error, 'Could not rejoin');
  }
});

// One appeal per suspension; admin reviews it and may reinstate early.
router.post('/me/appeal', authenticate, async (req, res) => {
  try {
    await standing.appeal(prisma, req.user.id, req.body?.message);
    return res.json({
      message: 'Appeal submitted. MarketBridge admin will review it.',
      standing: await standing.getStandingSummary(prisma, req.user.id),
    });
  } catch (error) {
    return sendError(req, res, error, 'Could not submit appeal');
  }
});

module.exports = router;
