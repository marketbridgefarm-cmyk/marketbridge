const express = require('express');
const multer = require('multer');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { makeDigitalKey, uploadPrivateObject, deletePrivateObject, signedDownloadUrl } = require('../utils/objectStorage');

const router = express.Router();

const MAX_BYTES = Number(process.env.DIGITAL_MAX_FILE_BYTES || 25 * 1024 * 1024); // 25MB default

// Allowed MIME types
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'video/mp4',
  'audio/mpeg',
];

// Multer configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    // Check MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
  }
  next();
};

// List active digital products
router.get('/', async (req, res) => {
  try {
    const { productType, search } = req.query;

    const products = await prisma.digitalProduct.findMany({
      where: {
        status: 'ACTIVE',
        ...(productType && { productType }),
        ...(search && {
          title: {
            contains: String(search).slice(0, 100),
            mode: 'insensitive',
          },
        }),
      },
      select: {
        id: true,
        title: true,
        productType: true,
        price: true,
        description: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        sellerId: true,
        seller: {
          select: {
            id: true,
            name: true,
            rating: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return res.json({ products });
  } catch (error) {
    console.error('LIST DIGITAL PRODUCTS ERROR:', error);
    return res.status(500).json({ error: 'Could not load digital products' });
  }
});

// List my digital products (seller)
router.get('/mine', authenticate, requireRole('SELLER'), async (req, res) => {
  try {
    const products = await prisma.digitalProduct.findMany({
      where: { sellerId: req.user.id },
      select: {
        id: true,
        title: true,
        productType: true,
        price: true,
        description: true,
        status: true,
        fileName: true,
        mimeType: true,
        fileSizeBytes: true,
        fileKey: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ products });
  } catch (error) {
    console.error('MY DIGITAL PRODUCTS ERROR:', error);
    return res.status(500).json({ error: 'Could not load your digital products' });
  }
});

// Upload digital product
router.post(
  '/',
  authenticate,
  requireRole('SELLER'),
  upload.single('file'),
  [
    body('title').isString().trim().isLength({ min: 1, max: 200 }),
    body('productType').isString().trim().isLength({ min: 1, max: 100 }),
    body('price').isFloat({ gt: 0 }),
    body('description').optional().isString().isLength({ max: 5000 }),
  ],
  validate,
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'A digital product file is required' });
      }

      if (req.file.size <= 0) {
        return res.status(400).json({ error: 'Invalid file' });
      }

      const id = require('crypto').randomUUID();
      const key = makeDigitalKey(id, req.file.originalname);

      try {
        await uploadPrivateObject({
          key,
          buffer: req.file.buffer,
          contentType: req.file.mimetype,
        });
      } catch (uploadError) {
        console.error('S3 UPLOAD ERROR:', uploadError);
        return res.status(502).json({ error: 'Could not store digital product file' });
      }

      try {
        const product = await prisma.digitalProduct.create({
          data: {
            id,
            sellerId: req.user.id,
            title: req.body.title,
            productType: req.body.productType,
            price: Number(req.body.price),
            fileKey: key,
            fileName: req.file.originalname.slice(0, 255),
            mimeType: req.file.mimetype.slice(0, 150),
            fileSizeBytes: req.file.size,
            description: req.body.description || null,
          },
        });

        return res.status(201).json({
          product: {
            id: product.id,
            title: product.title,
            productType: product.productType,
            price: product.price,
            description: product.description,
            fileName: product.fileName,
            fileSizeBytes: product.fileSizeBytes,
          },
        });
      } catch (dbError) {
        // Rollback: delete the uploaded file if DB insert fails
        await deletePrivateObject(key).catch(() => {});
        console.error('DIGITAL PRODUCT CREATE ERROR:', dbError);
        return res.status(500).json({ error: 'Could not create digital product' });
      }
    } catch (error) {
      console.error('DIGITAL PRODUCT UPLOAD ERROR:', error);
      return res.status(500).json({ error: 'Could not upload digital product' });
    }
  }
);

// Purchase digital product
router.post(
  '/:id/purchase',
  authenticate,
  requireRole('BUYER'),
  [
    param('id').isUUID(),
    body('method').isIn(['TELEBIRR', 'CBE', 'QR', 'OTHER']),
    body('reference').optional().isString().trim().isLength({ max: 200 }),
  ],
  validate,
  async (req, res) => {
    try {
      const product = await prisma.digitalProduct.findUnique({
        where: { id: req.params.id },
      });

      if (!product || product.status !== 'ACTIVE') {
        return res.status(404).json({ error: 'Digital product not found' });
      }

      if (!product.fileKey) {
        return res.status(409).json({ error: 'This product is not available for secure delivery yet' });
      }

      if (product.sellerId === req.user.id) {
        return res.status(400).json({ error: 'You cannot purchase your own product' });
      }

      const existing = await prisma.digitalPurchase.findUnique({
        where: {
          productId_buyerId: {
            productId: product.id,
            buyerId: req.user.id,
          },
        },
        include: { payment: true },
      });

      if (existing?.status === 'COMPLETED') {
        return res.status(409).json({
          error: 'You already own this product',
          purchase: existing,
        });
      }

      const result = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({
          data: {
            createdById: req.user.id,
            digitalProductId: product.id,
            type: 'DIGITAL',
            amount: product.price,
            method: req.body.method,
            reference: req.body.reference || null,
            status: 'PENDING',
          },
        });

        const purchase = existing
          ? await tx.digitalPurchase.update({
              where: { id: existing.id },
              data: { paymentId: payment.id, status: 'PENDING' },
            })
          : await tx.digitalPurchase.create({
              data: {
                productId: product.id,
                buyerId: req.user.id,
                paymentId: payment.id,
                status: 'PENDING',
              },
            });

        return { payment, purchase };
      });

      return res.status(201).json({
        message: 'Purchase created. Complete payment; access is granted only after verified payment.',
        ...result,
        paymentConfirmed: false,
      });
    } catch (error) {
      console.error('DIGITAL PURCHASE ERROR:', error);
      return res.status(500).json({ error: 'Could not create purchase' });
    }
  }
);

// Download purchased digital product
router.get(
  '/:id/download',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const purchase = await prisma.digitalPurchase.findUnique({
        where: { id: req.params.id },
        include: {
          product: true,
          payment: true,
        },
      });

      if (!purchase) {
        return res.status(404).json({ error: 'Purchase not found' });
      }

      if (purchase.buyerId !== req.user.id && !req.user.roles.includes('ADMIN')) {
        return res.status(403).json({ error: 'Not authorized to download this purchase' });
      }

      if (purchase.status !== 'COMPLETED' || purchase.payment.status !== 'PAID') {
        return res.status(403).json({
          error: 'Payment has not been verified; download unavailable',
        });
      }

      if (!purchase.product.fileKey) {
        return res.status(409).json({
          error: 'This product uses legacy storage and must be migrated before download',
        });
      }

      try {
        const url = await signedDownloadUrl({
          key: purchase.product.fileKey,
          fileName: purchase.product.fileName,
          contentType: purchase.product.mimeType,
        });

        await prisma.digitalPurchase.update({
          where: { id: purchase.id },
          data: { downloadCount: { increment: 1 } },
        });

        return res.json({
          downloadUrl: url,
          expiresInSeconds: Math.min(
            Math.max(Number(process.env.DIGITAL_DOWNLOAD_EXPIRES_SECONDS || 300), 60),
            900
          ),
        });
      } catch (downloadError) {
        console.error('DOWNLOAD ERROR:', downloadError);
        return res.status(503).json({ error: 'Secure download service is unavailable' });
      }
    } catch (error) {
      console.error('DIGITAL DOWNLOAD ERROR:', error);
      return res.status(500).json({ error: 'Could not process download request' });
    }
  }
);

// Get my purchases
router.get('/purchases/mine', authenticate, requireRole('BUYER'), async (req, res) => {
  try {
    const purchases = await prisma.digitalPurchase.findMany({
      where: { buyerId: req.user.id },
      include: {
        product: {
          select: {
            id: true,
            title: true,
            productType: true,
            price: true,
            description: true,
            sellerId: true,
            fileName: true,
            fileSizeBytes: true,
          },
        },
        payment: {
          select: {
            id: true,
            status: true,
            reference: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ purchases });
  } catch (error) {
    console.error('MY PURCHASES ERROR:', error);
    return res.status(500).json({ error: 'Could not load your purchases' });
  }
});

module.exports = router;
