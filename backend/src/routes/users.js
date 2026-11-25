'use strict';

const express = require('express');
const prisma = require('../config/db');
const { signedMediaUrl } = require('../utils/objectStorage');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Public profile photo. Sellers' photos appear next to their listings, so this needs no login.
// The bucket stays private: we redirect to a short-lived signed URL, and tell browsers/CDNs they may
// reuse the redirect for a few minutes (shorter than the signed URL's lifetime).
router.get('/:id/avatar', async (req, res) => {
  const { id } = req.params;
  if (!UUID.test(id)) return res.status(404).end();

  const user = await prisma.user.findUnique({ where: { id }, select: { avatarKey: true, accountStatus: true } });
  if (!user || !user.avatarKey || user.accountStatus !== 'ACTIVE') return res.status(404).end();

  let url;
  try {
    url = await signedMediaUrl({ key: user.avatarKey, fileName: 'avatar.webp', contentType: 'image/webp', disposition: 'inline' });
  } catch (error) {
    req.log?.error({ err: error }, 'Avatar signing failed');
    return res.status(503).end();
  }

  // Helmet defaults to same-origin; the web app is on a different origin and must be able to show this image.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Cache-Control', 'public, max-age=240');
  return res.redirect(302, url);
});

module.exports = router;
