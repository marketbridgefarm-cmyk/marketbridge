'use strict';
const express = require('express');
const prisma = require('../config/db');
const router = express.Router();

router.get('/ethiopia', async (req, res) => {
  try {
    const level = req.query.level ? String(req.query.level).toUpperCase() : undefined;
    const parentId = req.query.parentId ? String(req.query.parentId) : undefined;
    const locations = await prisma.ethiopiaLocation.findMany({
      where: { ...(level && { level }), ...(parentId && { parentId }) },
      orderBy: [{ level: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, nameAm: true, nameOm: true, code: true, level: true, latitude: true, longitude: true, parentId: true },
    });
    res.json({ locations });
  } catch (error) {
    console.error('LOCATION LOOKUP ERROR:', error);
    res.status(500).json({ error: 'Could not load Ethiopian locations' });
  }
});

router.get('/ethiopia/:id', async (req, res) => {
  const location = await prisma.ethiopiaLocation.findUnique({
    where: { id: req.params.id },
    include: { parent: true, children: { orderBy: { name: 'asc' } } },
  });
  if (!location) return res.status(404).json({ error: 'Location not found' });
  res.json({ location });
});

module.exports = router;
