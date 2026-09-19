const express = require('express');
const multer = require('multer');
const { body, param, validationResult } = require('express-validator');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { makeDigitalKey, uploadPrivateObject, deletePrivateObject, signedDownloadUrl } = require('../utils/objectStorage');
const { createPayment } = require('../services/paymentService');
const { optimizeUpload } = require('../utils/imageProcessor');
const { idempotency } = require('../middleware/idempotency');
const { streamDigitalPurchaseReceiptPdf } = require('../services/receiptService');

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
  'text/plain',
  'text/markdown',
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

// Two near-simultaneous purchase requests for the same buyer+product (a
// double-tap, a retried request, two open tabs) can both pass the
// "does a purchase row already exist?" check before either has written
// one, then both converge on the same underlying Payment via idempotency
// and race to insert a DigitalPurchase pointing at it. DigitalPurchase.
// paymentId is unique, so the loser of that race gets a P2002 here rather
// than a real error — recover by returning whichever row actually landed.
async function createPurchaseIdempotent({ productId, buyerId, paymentId, status }) {
  try {
    return await prisma.digitalPurchase.create({
      data: { productId, buyerId, paymentId, status },
      include: { payment: true },
    });
  } catch (error) {
    if (error.code === 'P2002') {
      const winner = await prisma.digitalPurchase.findFirst({
        where: { OR: [{ productId, buyerId }, { paymentId }] },
        include: { payment: true },
      });
      if (winner) return winner;
    }
    throw error;
  }
}

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
    req.log.error({ err: error }, 'LIST DIGITAL PRODUCTS ERROR:');
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
    req.log.error({ err: error }, 'MY DIGITAL PRODUCTS ERROR:');
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
      let uploadBuffer = req.file.buffer;
      let uploadContentType = req.file.mimetype;
      let uploadExtension = require('path').extname(req.file.originalname).toLowerCase();
      let imageStats = null;

      if (req.file.mimetype.startsWith('image/')) {
        const optimized = await optimizeUpload({
          buffer: req.file.buffer,
          mime: req.file.mimetype,
          maxWidth: Number(process.env.DIGITAL_IMAGE_MAX_WIDTH || 2400),
          maxHeight: Number(process.env.DIGITAL_IMAGE_MAX_HEIGHT || 2400),
          quality: Number(process.env.DIGITAL_IMAGE_QUALITY || 84),
        });
        uploadBuffer = optimized.buffer;
        uploadContentType = optimized.contentType;
        uploadExtension = optimized.extension;
        imageStats = optimized;
      }

      const key = makeDigitalKey(id, `upload${uploadExtension}`);

      try {
        await uploadPrivateObject({
          key,
          buffer: uploadBuffer,
          contentType: uploadContentType,
        });
      } catch (uploadError) {
        req.log.error({ err: uploadError }, 'S3 UPLOAD ERROR:');
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
            mimeType: uploadContentType.slice(0, 150),
            fileSizeBytes: uploadBuffer.length,
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
        req.log.error({ err: dbError }, 'DIGITAL PRODUCT CREATE ERROR:');
        return res.status(500).json({ error: 'Could not create digital product' });
      }
    } catch (error) {
      req.log.error({ err: error }, 'DIGITAL PRODUCT UPLOAD ERROR:');
      return res.status(500).json({ error: 'Could not upload digital product' });
    }
  }
);

// Purchase digital product
router.post(
  '/:id/purchase',
  authenticate,
  requireRole('BUYER'),
  idempotency('digital.purchase'),
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

      // A retry of an unfinished purchase should reuse the existing payment
      // rather than orphaning it and attaching a new payment to the same
      // DigitalPurchase. This also keeps digital checkout on the same
      // commission/audit/idempotency path as every other MarketBridge payment.
      if (existing?.payment && ['PENDING', 'PAID', 'RECONCILIATION_REQUIRED'].includes(existing.payment.status)) {
        return res.status(200).json({
          message: 'Purchase already exists. Continue the existing payment.',
          payment: existing.payment,
          purchase: existing,
          paymentConfirmed: existing.payment.status === 'PAID',
          replayed: true,
        });
      }

      // Recover a payment that was created immediately before a process
      // interruption prevented the DigitalPurchase row from being inserted.
      // This prevents a retry from creating a second active payment.
      const orphanPayment = existing
        ? null
        : await prisma.payment.findFirst({
            where: {
              createdById: req.user.id,
              digitalProductId: product.id,
              type: 'DIGITAL',
              status: { in: ['PENDING', 'PAID', 'RECONCILIATION_REQUIRED'] },
            },
            orderBy: { createdAt: 'desc' },
          });

      if (orphanPayment) {
        const recovered = await createPurchaseIdempotent({
          productId: product.id,
          buyerId: req.user.id,
          paymentId: orphanPayment.id,
          status: orphanPayment.status === 'PAID' ? 'COMPLETED' : 'PENDING',
        });
        return res.status(200).json({
          message: 'Purchase recovered. Continue the existing payment.',
          payment: recovered.payment,
          purchase: recovered,
          paymentConfirmed: recovered.payment.status === 'PAID',
          replayed: true,
        });
      }

      const idempotencyKey = req.get('Idempotency-Key') || req.body.idempotencyKey || null;
      if (idempotencyKey && String(idempotencyKey).length > 200) {
        return res.status(400).json({ error: 'Idempotency-Key must be 200 characters or fewer' });
      }

      const payment = await createPayment({
        createdById: req.user.id,
        digitalProductId: product.id,
        type: 'DIGITAL',
        amount: product.price,
        method: req.body.method,
        reference: req.body.reference || null,
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
      });

      // A failed/refunded/cancelled digital payment must not permanently
      // consume the unique (product,buyer) purchase row. Rebind that row to
      // the new payment so "try again" works without violating the unique
      // constraint.
      const purchase = existing
        ? await prisma.digitalPurchase.update({
            where: { id: existing.id },
            data: {
              paymentId: payment.id,
              status: 'PENDING',
            },
            include: { payment: true },
          })
        : await createPurchaseIdempotent({
            productId: product.id,
            buyerId: req.user.id,
            paymentId: payment.id,
            status: 'PENDING',
          });

      const result = { payment, purchase };

      return res.status(201).json({
        message: 'Purchase created. Complete payment; access is granted only after verified payment.',
        ...result,
        paymentConfirmed: false,
      });
    } catch (error) {
      req.log.error({ err: error }, 'DIGITAL PURCHASE ERROR:');
      return res.status(error.status || 500).json({
        error: error.status ? error.message : 'Could not create purchase',
        ...(error.code ? { code: error.code } : {}),
      });
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
        req.log.error({ err: downloadError }, 'DOWNLOAD ERROR:');
        return res.status(503).json({ error: 'Secure download service is unavailable' });
      }
    } catch (error) {
      req.log.error({ err: error }, 'DIGITAL DOWNLOAD ERROR:');
      return res.status(500).json({ error: 'Could not process download request' });
    }
  }
);

// ============================================================================
// DIGITAL PURCHASE RECEIPT (PDF)
// ============================================================================
// Downloadable receipt for a Digital-marketplace purchase, covering the
// same ground as the physical-order receipt (payment, method, reference,
// any refund) so the Digital marketplace isn't left without one. Available
// as soon as the purchase payment has actually been made — not gated on
// any later status — for the same reason order receipts aren't gated on
// COMPLETED: the buyer/seller may need proof of payment right away.
// ============================================================================
router.get(
  '/purchases/:id/receipt',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const purchase = await prisma.digitalPurchase.findUnique({
        where: { id: req.params.id },
        include: {
          product: { include: { seller: { select: { id: true, name: true, phone: true } } } },
          buyer: { select: { id: true, name: true, phone: true } },
          payment: { include: { refunds: true } },
        },
      });

      if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

      const allowed = req.user.roles?.includes('ADMIN') ||
        purchase.buyerId === req.user.id ||
        purchase.product?.sellerId === req.user.id;

      if (!allowed) return res.status(403).json({ error: 'Not authorized to view this purchase' });

      if (!purchase.payment || purchase.payment.status === 'PENDING') {
        return res.status(409).json({
          error: 'A receipt is only available once payment has been made.',
        });
      }

      return streamDigitalPurchaseReceiptPdf(purchase, res);
    } catch (error) {
      req.log.error({ err: error }, 'DIGITAL RECEIPT ERROR:');
      if (res.headersSent) return res.end();
      return res.status(500).json({ error: 'Could not generate receipt' });
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
    req.log.error({ err: error }, 'MY PURCHASES ERROR:');
    return res.status(500).json({ error: 'Could not load your purchases' });
  }
});

module.exports = router;
