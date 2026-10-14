const prisma = require('../../config/db');

// GET /api/offers/notices, PATCH /api/offers/notices/read
async function listNotices(req, res) {
  try {
    const notices = await prisma.offerNotification.findMany({
      where: { userId: req.user.id },
      orderBy: [{ createdAt: 'desc' }],
      take: 50,
    });
    return res.json({
      notices,
      unreadCount: notices.filter((notice) => !notice.readAt).length,
    });
  } catch (error) {
    req.log.error({ err: error }, 'LIST OFFER NOTICES ERROR');
    return res.status(500).json({ error: 'Failed to load notices' });
  }
}

async function markNoticesRead(req, res) {
  try {
    await prisma.offerNotification.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ ok: true });
  } catch (error) {
    req.log.error({ err: error }, 'READ OFFER NOTICES ERROR');
    return res.status(500).json({ error: 'Failed to update notices' });
  }
}

module.exports = { listNotices, markNoticesRead };
