'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { getMarketplaceAnalytics } = require('../services/growthAnalyticsService');

const router = express.Router();

router.get('/analytics/me', authenticate, async (req, res) => {
  try { return res.json({ analytics: await getMarketplaceAnalytics(req.user.id) }); }
  catch (error) { req.log.error({ err: error }, 'GROWTH ANALYTICS ERROR:'); return res.status(500).json({ error: 'Could not load analytics' }); }
});

router.post('/promotions/validate', authenticate, [body('code').isString().trim().isLength({ min: 3, max: 32 }), body('subtotal').isFloat({ min: 0 })], async (req, res) => {
  try {
    const errors = validationResult(req); if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const code = req.body.code.toUpperCase(); const subtotal = Number(req.body.subtotal);
    const promo = await prisma.promotionCode.findUnique({ where: { code } });
    if (!promo || !promo.active) return res.status(404).json({ error: 'Promotion code not found or inactive' });
    const now = new Date();
    if (now < promo.startsAt || now > promo.endsAt) return res.status(400).json({ error: 'Promotion code is outside its valid period' });
    if (promo.maxUses != null && promo.usedCount >= promo.maxUses) return res.status(400).json({ error: 'Promotion code has reached its usage limit' });
    if (subtotal < Number(promo.minimumSubtotal)) return res.status(400).json({ error: `Minimum subtotal is ${Number(promo.minimumSubtotal).toLocaleString()} ETB` });
    const prior = await prisma.promotionRedemption.findUnique({ where: { promotionCodeId_userId: { promotionCodeId: promo.id, userId: req.user.id } } });
    if (prior) return res.status(409).json({ error: 'You have already used this promotion code' });
    const raw = promo.discountType === 'PERCENTAGE' ? subtotal * Number(promo.discountValue) / 100 : Number(promo.discountValue);
    const discount = Math.min(subtotal, promo.maxDiscount == null ? raw : Math.min(raw, Number(promo.maxDiscount)));
    return res.json({ valid: true, code: promo.code, discount: Number(discount.toFixed(2)), total: Number((subtotal - discount).toFixed(2)), currency: 'ETB' });
  } catch (error) { req.log.error({ err: error }, 'PROMOTION VALIDATE ERROR:'); return res.status(500).json({ error: 'Could not validate promotion' }); }
});

router.get('/promotions', authenticate, async (req, res) => {
  const now = new Date();
  const promotions = await prisma.promotionCode.findMany({ where: { active: true, startsAt: { lte: now }, endsAt: { gte: now } }, orderBy: { endsAt: 'asc' }, take: 20, select: { code: true, discountType: true, discountValue: true, maxDiscount: true, minimumSubtotal: true, endsAt: true } });
  return res.json({ promotions });
});

router.post('/referrals/claim', authenticate, [body('code').isString().trim().isLength({ min: 6, max: 32 })], async (req, res) => {
  try {
    const errors = validationResult(req); if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const code = req.body.code.toUpperCase();
    const referral = await prisma.referralCode.findUnique({ where: { code } });
    if (!referral) return res.status(404).json({ error: 'Referral code not found' });
    if (referral.ownerId === req.user.id) return res.status(400).json({ error: 'You cannot claim your own referral code' });
    const existing = await prisma.referralClaim.findUnique({ where: { referralCodeId_userId: { referralCodeId: referral.id, userId: req.user.id } } });
    if (existing) return res.status(409).json({ error: 'Referral already claimed' });
    const claim = await prisma.$transaction(async tx => {
      const created = await tx.referralClaim.create({ data: { referralCodeId: referral.id, userId: req.user.id } });
      await tx.referralCode.update({ where: { id: referral.id }, data: { claimCount: { increment: 1 } } });
      return created;
    });
    return res.status(201).json({ claimed: true, claimId: claim.id });
  } catch (error) { req.log.error({ err: error }, 'REFERRAL CLAIM ERROR:'); return res.status(500).json({ error: 'Could not claim referral code' }); }
});

router.post('/referrals/mine', authenticate, async (req, res) => {
  const existing = await prisma.referralCode.findUnique({ where: { ownerId: req.user.id } });
  if (existing) return res.json({ referral: existing });
  const code = `MB${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const referral = await prisma.referralCode.create({ data: { ownerId: req.user.id, code } });
  return res.status(201).json({ referral });
});

router.post('/promotions/admin', authenticate, requireRole('ADMIN'), [body('code').isString().trim().isLength({ min: 3, max: 32 }), body('discountType').isIn(['PERCENTAGE','FIXED']), body('discountValue').isFloat({ min: 0.01 }), body('startsAt').isISO8601(), body('endsAt').isISO8601(), body('minimumSubtotal').optional().isFloat({ min: 0 }), body('maxDiscount').optional().isFloat({ min: 0 })], async (req, res) => {
  const errors = validationResult(req); if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const data = { code: req.body.code.toUpperCase(), discountType: req.body.discountType, discountValue: Number(req.body.discountValue), startsAt: new Date(req.body.startsAt), endsAt: new Date(req.body.endsAt), minimumSubtotal: Number(req.body.minimumSubtotal || 0), maxDiscount: req.body.maxDiscount == null ? null : Number(req.body.maxDiscount), maxUses: req.body.maxUses == null ? null : Number(req.body.maxUses) };
    if (data.endsAt <= data.startsAt) return res.status(400).json({ error: 'endsAt must be after startsAt' });
    const promotion = await prisma.promotionCode.create({ data });
    return res.status(201).json({ promotion });
  } catch (error) { if (error.code === 'P2002') return res.status(409).json({ error: 'Promotion code already exists' }); return res.status(500).json({ error: 'Could not create promotion' }); }
});

module.exports = router;
