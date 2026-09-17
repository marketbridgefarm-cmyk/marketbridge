'use strict';

/**
 * Hand-authored, durable component schemas — the entities themselves
 * (User, Listing, Order, Payment, ...) change far less often than the
 * route table does, so unlike openapi/openapi.json these are safe to
 * maintain by hand rather than regenerate. Keep these in sync with
 * backend/prisma/schema.prisma when a model's public-facing shape changes.
 *
 * These are intentionally "the fields an API consumer will actually see",
 * not a 1:1 mirror of every Prisma column — internal-only fields
 * (passwordHash, mfaSecret, fileUrl legacy field, etc.) are omitted.
 */

const enums = {
  Role: ['SELLER', 'BUYER', 'INSPECTOR', 'TRUCK_OWNER', 'ADVERTISER', 'ADMIN'],
  AccountStatus: ['ACTIVE', 'SUSPENDED'],
  ListingCategory: ['AGRICULTURAL', 'PRODUCT', 'DIGITAL'],
  Region: [
    'TIGRAY', 'AFAR', 'AMHARA', 'OROMIA', 'SOMALI', 'BENISHANGUL_GUMUZ',
    'GAMBELA', 'HARARI', 'SIDAMA', 'SOUTH_ETHIOPIA', 'SOUTH_WEST_ETHIOPIA_PEOPLES',
    'CENTRAL_ETHIOPIA', 'ADDIS_ABABA', 'DIRE_DAWA',
  ],
  ListingStatus: ['DRAFT', 'ACTIVE', 'UNDER_NEGOTIATION', 'SOLD', 'CANCELLED', 'EXPIRED'],
  OfferStatus: ['PENDING', 'COUNTERED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'],
  InspectionMode: ['SELLER_REQUESTED', 'BUYER_REQUESTED', 'JOINT'],
  InspectionStatus: ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  BuyerDecision: ['BUY', 'CANCEL'],
  OrderStatus: [    'PENDING_PAYMENT', 'CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT',
    'DELIVERED', 'COMPLETED', 'DISPUTED', 'CANCELLED',
  ],
  ArrangingParty: ['SELLER', 'BUYER', 'JOINT'],
  TransportMethod: ['OWN_TRUCK', 'HIRE_TRANSPORTER'],
  TransportStatus: ['REQUESTED', 'ACCEPTED', 'QUOTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'],
  PaymentType: ['MARKETPLACE', 'TRANSPORT', 'INSPECTOR', 'ADVERTISING', 'DIGITAL'],
  PaymentMethod: ['TELEBIRR', 'CBE', 'QR', 'OTHER'],
  PaymentStatus: ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REFUNDED', 'REFUND_PENDING', 'RECONCILIATION_REQUIRED'],
  AdType: ['FEATURED_LISTING', 'TOP_OF_CATEGORY', 'SPONSORED_SEARCH', 'BANNER', 'TELEGRAM_PROMOTION'],
  AdStatus: [
    'PENDING', 'ACTIVE', 'PENDING_PAYMENT', 'PAID_PENDING_REVIEW', 'APPROVED',
    'SCHEDULED', 'PUBLISHED', 'EXPIRED', 'REJECTED', 'CANCELLED',
  ],
  DisputeStatus: ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED'],
  VerificationStatus: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'],
};

const schemas = {
  Error: {
    type: 'object',
    properties: {
      error: { type: 'string', description: 'Human-readable error message.' },
      code: { type: 'string', description: 'Stable machine-readable error code, when available.' },
      errors: {
        type: 'array',
        description: 'Present on 400 validation failures — one entry per invalid field (express-validator format).',
        items: { type: 'object' },
      },
    },
    required: ['error'],
  },

  User: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
      phone: { type: 'string', nullable: true },
      roles: { type: 'array', items: { type: 'string', enum: enums.Role } },
      location: { type: 'string', nullable: true },
      region: { type: 'string', enum: enums.Region, nullable: true },
      latitude: { type: 'number', nullable: true },
      longitude: { type: 'number', nullable: true },
      verificationStatus: { type: 'string', enum: enums.VerificationStatus },
      accountStatus: { type: 'string', enum: enums.AccountStatus },
      mfaEnabled: { type: 'boolean' },
      smsNotificationsEnabled: { type: 'boolean' },
      preferredLanguage: { type: 'string' },
      rating: { type: 'number', description: 'Average rating across received Rating records.' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  Listing: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      sellerId: { type: 'string', format: 'uuid' },
      category: { type: 'string', enum: enums.ListingCategory },
      title: { type: 'string', nullable: true },
      cropType: { type: 'string', nullable: true },
      quantity: { type: 'number' },
      availableQuantity: { type: 'number' },
      unit: { type: 'string' },
      askingPrice: { type: 'string', description: 'Decimal(18,2), serialized as string.' },
      minAcceptablePrice: { type: 'string', nullable: true },
      location: { type: 'string' },
      region: { type: 'string', enum: enums.Region, nullable: true },
      zone: { type: 'string', nullable: true },
      woreda: { type: 'string', nullable: true },
      kebele: { type: 'string', nullable: true },
      latitude: { type: 'number', nullable: true },
      longitude: { type: 'number', nullable: true },
      harvestedDate: { type: 'string', format: 'date-time', nullable: true },
      readinessDate: { type: 'string', format: 'date-time', nullable: true },
      pickupWindowStart: { type: 'string', format: 'date-time', nullable: true },
      pickupWindowEnd: { type: 'string', format: 'date-time', nullable: true },
      photos: { type: 'array', items: { type: 'string' }, description: 'Signed, short-lived URLs — resolved at response time, not stored.' },
      videos: { type: 'array', items: { type: 'string' } },
      description: { type: 'string', nullable: true },
      status: { type: 'string', enum: enums.ListingStatus },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  Offer: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      listingId: { type: 'string', format: 'uuid' },
      buyerId: { type: 'string', format: 'uuid' },
      sellerId: { type: 'string', format: 'uuid' },
      amount: { type: 'string' },
      quantity: { type: 'number', nullable: true },
      parentOfferId: { type: 'string', format: 'uuid', nullable: true },
      expiresAt: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string', enum: enums.OfferStatus },
      counterAmount: { type: 'string', nullable: true },
      counteredBy: { type: 'string', enum: ['BUYER', 'SELLER'], nullable: true },
      message: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  Order: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      listingId: { type: 'string', format: 'uuid' },
      buyerId: { type: 'string', format: 'uuid' },
      sellerId: { type: 'string', format: 'uuid' },
      finalPrice: { type: 'string' },
      quantity: { type: 'number' },
      status: { type: 'string', enum: enums.OrderStatus },
      buyerDecision: { type: 'string', enum: enums.BuyerDecision, nullable: true },
      buyerDecisionAt: { type: 'string', format: 'date-time', nullable: true },
      arrangingParty: { type: 'string', enum: enums.ArrangingParty, nullable: true },
      paymentDueAt: { type: 'string', format: 'date-time', nullable: true, description: 'Order auto-cancels and releases inventory if still PENDING_PAYMENT after this time.' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  Payment: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid', nullable: true },
      digitalProductId: { type: 'string', format: 'uuid', nullable: true },
      advertisementId: { type: 'string', format: 'uuid', nullable: true },
      inspectionRequestId: { type: 'string', format: 'uuid', nullable: true },
      transportJobId: { type: 'string', format: 'uuid', nullable: true },
      type: { type: 'string', enum: enums.PaymentType },
      amount: { type: 'string' },
      currency: { type: 'string', default: 'ETB' },
      method: { type: 'string', enum: enums.PaymentMethod },
      status: { type: 'string', enum: enums.PaymentStatus },
      reference: { type: 'string', nullable: true },
      idempotencyKey: { type: 'string', nullable: true },
      provider: { type: 'string', nullable: true },
      providerTransactionId: { type: 'string', nullable: true },
      commissionRate: { type: 'number', nullable: true },
      commissionAmount: { type: 'string', nullable: true },
      netAmount: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  InspectionRequest: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      listingId: { type: 'string', format: 'uuid' },
      requestedById: { type: 'string', format: 'uuid' },
      inspectorId: { type: 'string', format: 'uuid', nullable: true },
      mode: { type: 'string', enum: enums.InspectionMode },
      status: { type: 'string', enum: enums.InspectionStatus },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  InspectionReport: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      requestId: { type: 'string', format: 'uuid' },
      quantity: { type: 'number' },
      grade: { type: 'string', nullable: true },
      moisture: { type: 'number', nullable: true },
      visibleDefects: { type: 'string', nullable: true },
      damageNotes: { type: 'string', nullable: true },
      packagingNotes: { type: 'string', nullable: true },
      photos: { type: 'array', items: { type: 'string' } },
      videos: { type: 'array', items: { type: 'string' } },
      gpsLocation: { type: 'string', nullable: true },
      inspectedAt: { type: 'string', format: 'date-time' },
    },
  },

  TransportJob: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      arrangingParty: { type: 'string', enum: enums.ArrangingParty },
      method: { type: 'string', enum: enums.TransportMethod },
      truckOwnerId: { type: 'string', format: 'uuid', nullable: true },
      truckId: { type: 'string', format: 'uuid', nullable: true },
      pickupLocation: { type: 'string' },
      destination: { type: 'string' },
      load: { type: 'string' },
      requiredCapacity: { type: 'number', nullable: true },
      specialRequirements: { type: 'string', nullable: true },
      agreedAmount: { type: 'string', nullable: true },
      status: { type: 'string', enum: enums.TransportStatus },
      pickupConfirmedAt: { type: 'string', format: 'date-time', nullable: true },
      deliveredConfirmedAt: { type: 'string', format: 'date-time', nullable: true },
      incidentNotes: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  DigitalProduct: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      sellerId: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      productType: { type: 'string' },
      price: { type: 'string' },
      fileName: { type: 'string', nullable: true },
      mimeType: { type: 'string', nullable: true },
      fileSizeBytes: { type: 'integer', nullable: true },
      description: { type: 'string', nullable: true },
      status: { type: 'string', enum: enums.ListingStatus },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  Dispute: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      raisedById: { type: 'string', format: 'uuid' },
      againstId: { type: 'string', format: 'uuid' },
      disputeType: { type: 'string' },
      description: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: enums.DisputeStatus },
      resolution: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },

  Rating: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      fromUserId: { type: 'string', format: 'uuid' },
      toUserId: { type: 'string', format: 'uuid' },
      role: { type: 'string', enum: enums.Role },
      score: { type: 'integer', minimum: 1, maximum: 5 },
      comment: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  Message: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid', nullable: true },
      senderId: { type: 'string', format: 'uuid' },
      receiverId: { type: 'string', format: 'uuid' },
      content: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  Notification: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      userId: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid', nullable: true },
      type: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      action: { type: 'object', nullable: true, description: 'Client navigation hint, e.g. { "path": "/orders/<id>" }.' },
      readAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  Advertisement: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      advertiserId: { type: 'string', format: 'uuid' },
      listingId: { type: 'string', format: 'uuid', nullable: true },
      type: { type: 'string', enum: enums.AdType },
      status: { type: 'string', enum: enums.AdStatus },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
      priceQuoted: { type: 'string' },
      amountPaid: { type: 'string', nullable: true },
      currency: { type: 'string', default: 'ETB' },
      campaignReference: { type: 'string' },
      headline: { type: 'string', nullable: true },
      destinationUrl: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
};

module.exports = {
  components: { schemas },
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Short-lived access token from POST /auth/login, POST /auth/register, or POST /auth/refresh. ' +
        'Send as `Authorization: Bearer <token>`. The long-lived refresh token is a separate ' +
        'HttpOnly cookie and is never sent in a response body.',
    },
  },
};
