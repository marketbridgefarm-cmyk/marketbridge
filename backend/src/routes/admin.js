'use strict';

const express = require('express');
const prisma = require('../config/db');
const {
  authenticate,
} = require('../middleware/auth');
const {
  requireRole,
  requireMfa,
} = require('../middleware/roleCheck');
const {
  recordAuditEvent,
} = require('../utils/audit');
const { revokeAllSessions } = require('../services/refreshSessionService');
const { completeRefund, failRefund } = require('../services/paymentRefundService');
const { resolveReconciliation } = require('../services/paymentReconciliationService');
const { markPaidOut } = require('../services/sellerPayoutService');

const router = express.Router();


// ============================================================================
// ADMIN AUTHORIZATION
// ============================================================================

router.use(
  authenticate,
  requireRole('ADMIN'),
  requireMfa()
);


// ============================================================================
// CONSTANTS
// ============================================================================

const VALID_ROLES = [
  'SELLER',
  'BUYER',
  'INSPECTOR',
  'TRUCK_OWNER',
  'ADVERTISER',
  'ADMIN',
];

const VALID_VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'REJECTED',
];

const VALID_ACCOUNT_STATUSES = [
  'ACTIVE',
  'SUSPENDED',
];


// ============================================================================
// HELPERS
// ============================================================================

function money(value) {
  return Number(
    Number(value || 0).toFixed(2)
  );
}


// ============================================================================
// ADMIN OVERVIEW
// ============================================================================

router.get(
  '/overview',
  async (req, res) => {
    try {
      const [
        users,
        listings,
        orders,
        disputes,
        activeAds,
        payments,
        suspendedUsers,
        commissionTotal,
        sellerEarnings,
        transporterEarnings,
      ] = await Promise.all([
        prisma.user.count(),

        prisma.listing.count(),

        prisma.order.count(),

        prisma.dispute.count({
          where: {
            status:
              'OPEN',
          },
        }),

        prisma.advertisement.count({
          where: {
            status: { in: ['ACTIVE', 'PUBLISHED', 'SCHEDULED'] },
            startDate: { lte: new Date() },
            endDate: { gte: new Date() },
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            amount:
              true,
          },

          where: {
            status:
              'PAID',
          },
        }),

        prisma.user.count({
          where: {
            accountStatus:
              'SUSPENDED',
          },
        }),

        prisma.paymentLedgerEntry.aggregate({
          _sum: {
            amount:
              true,
          },

          where: {
            type:
              'PLATFORM_COMMISSION',
          },
        }),

        prisma.paymentLedgerEntry.aggregate({
          _sum: {
            amount:
              true,
          },

          where: {
            type:
              'SELLER_EARNING',
          },
        }),

        prisma.paymentLedgerEntry.aggregate({
          _sum: {
            amount:
              true,
          },

          where: {
            type:
              'TRANSPORTER_EARNING',
          },
        }),
      ]);


      return res.json({
        users,

        listings,

        orders,

        openDisputes:
          disputes,

        activeAds,

        suspendedUsers,

        totalPaidVolume:
          money(
            payments._sum.amount
          ),

        totalPlatformCommission:
          money(
            commissionTotal._sum.amount
          ),

        totalSellerEarnings:
          money(
            sellerEarnings._sum.amount
          ),

        totalTransporterEarnings:
          money(
            transporterEarnings._sum.amount
          ),
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN OVERVIEW ERROR:');

      return res.status(500).json({
        error:
          'Could not load admin overview',
      });
    }
  }
);


// ============================================================================
// PAYMENT OVERVIEW
// ============================================================================

router.get(
  '/payments/overview',
  async (req, res) => {
    try {
      const [
        paid,
        pending,
        failed,
        refunded,
        reconciliationRequired,
        marketplace,
        transport,
        inspector,
        advertising,
      ] = await Promise.all([
        prisma.payment.aggregate({
          _sum: {
            amount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            status:
              'PAID',
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            amount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            status:
              'PENDING',
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            amount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            status:
              'FAILED',
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            amount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            status:
              'REFUNDED',
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            amount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            status:
              'RECONCILIATION_REQUIRED',
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            amount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            type:
              'MARKETPLACE',

            status:
              'PAID',
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            amount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            type:
              'TRANSPORT',

            status:
              'PAID',
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            amount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            type:
              'INSPECTOR',

            status:
              'PAID',
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            amount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            type:
              'ADVERTISING',

            status:
              'PAID',
          },
        }),
      ]);


      return res.json({
        payments: {
          paid: {
            count:
              paid._count.id,

            amount:
              money(
                paid._sum.amount
              ),
          },

          pending: {
            count:
              pending._count.id,

            amount:
              money(
                pending._sum.amount
              ),
          },

          failed: {
            count:
              failed._count.id,

            amount:
              money(
                failed._sum.amount
              ),
          },

          refunded: {
            count:
              refunded._count.id,

            amount:
              money(
                refunded._sum.amount
              ),
          },

          reconciliationRequired: {
            count:
              reconciliationRequired._count.id,

            amount:
              money(
                reconciliationRequired._sum.amount
              ),
          },
        },

        byType: {
          marketplace: {
            count:
              marketplace._count.id,

            amount:
              money(
                marketplace._sum.amount
              ),
          },

          transport: {
            count:
              transport._count.id,

            amount:
              money(
                transport._sum.amount
              ),
          },

          inspector: {
            count:
              inspector._count.id,

            amount:
              money(
                inspector._sum.amount
              ),
          },

          advertising: {
            count:
              advertising._count.id,

            amount:
              money(
                advertising._sum.amount
              ),
          },
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN PAYMENT OVERVIEW ERROR:');

      return res.status(500).json({
        error:
          'Could not load payment overview',
      });
    }
  }
);


// ============================================================================
// LIST PAYMENTS
// ============================================================================

router.get(
  '/payments',
  async (req, res) => {
    try {
      const payments =
        await prisma.payment.findMany({
          include: {
            order: {
              include: {
                buyer: {
                  select: {
                    id:
                      true,

                    name:
                      true,

                    email:
                      true,
                  },
                },

                seller: {
                  select: {
                    id:
                      true,

                    name:
                      true,

                    email:
                      true,
                  },
                },
              },
            },

            transportJob: {
              select: {
                id:
                  true,

                method:
                  true,

                status:
                  true,

                agreedAmount:
                  true,

                truckOwnerId:
                  true,

                truckOwner: {
                  select: {
                    id:
                      true,

                    name:
                      true,

                    email:
                      true,
                  },
                },
              },
            },

            inspectionRequest: {
              select: {
                id:
                  true,

                inspectorId:
                  true,
              },
            },

            ledgerEntries: {
              orderBy: {
                createdAt:
                  'asc',
              },
            },
          },

          orderBy: {
            createdAt:
              'desc',
          },

          take: 500,
        });


      return res.json({
        payments,

        count:
          payments.length,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN PAYMENTS ERROR:');

      return res.status(500).json({
        error:
          'Could not load payments',
      });
    }
  }
);


// ============================================================================
// COMMISSION SUMMARY
// ============================================================================
//
// The actual commission record in the current payment architecture is:
//
// PaymentLedgerEntry.type = PLATFORM_COMMISSION
//
// This endpoint deliberately reports commission from the ledger rather than
// calculating it again from payment amounts.
//
// ============================================================================

router.get(
  '/commissions/stats',
  async (req, res) => {
    try {
      const [
        all,
        marketplace,
        transport,
        inspection,
        digital,
      ] = await Promise.all([
        prisma.paymentLedgerEntry.aggregate({
          _sum: {
            amount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            type:
              'PLATFORM_COMMISSION',
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            commissionAmount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            type:
              'MARKETPLACE',

            status:
              'PAID',

            commissionAmount: {
              gt:
                0,
            },
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            commissionAmount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            type:
              'TRANSPORT',

            status:
              'PAID',

            commissionAmount: {
              gt:
                0,
            },
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            commissionAmount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            type:
              'INSPECTOR',

            status:
              'PAID',

            commissionAmount: {
              gt:
                0,
            },
          },
        }),

        prisma.payment.aggregate({
          _sum: {
            commissionAmount:
              true,
          },

          _count: {
            id:
              true,
          },

          where: {
            type:
              'DIGITAL',

            status:
              'PAID',

            commissionAmount: {
              gt:
                0,
            },
          },
        }),
      ]);


      return res.json({
        total: {
          records:
            all._count.id,

          amount:
            money(
              all._sum.amount
            ),
        },

        marketplace: {
          payments:
            marketplace._count.id,

          commission:
            money(
              marketplace._sum.commissionAmount
            ),
        },

        transport: {
          payments:
            transport._count.id,

          commission:
            money(
              transport._sum.commissionAmount
            ),
        },

        inspection: {
          payments:
            inspection._count.id,

          commission:
            money(
              inspection._sum.commissionAmount
            ),
        },

        digital: {
          payments:
            digital._count.id,

          commission:
            money(
              digital._sum.commissionAmount
            ),
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN COMMISSION STATS ERROR:');

      return res.status(500).json({
        error:
          'Could not load commission statistics',
      });
    }
  }
);


// ============================================================================
// LIST COMMISSIONS
// ============================================================================

router.get(
  '/commissions',
  async (req, res) => {
    try {
      const entries =
        await prisma.paymentLedgerEntry.findMany({
          where: {
            type:
              'PLATFORM_COMMISSION',
          },

          include: {
            payment: {
              include: {
                order: {
                  include: {
                    buyer: {
                      select: {
                        id:
                          true,

                        name:
                          true,

                        email:
                          true,
                      },
                    },

                    seller: {
                      select: {
                        id:
                          true,

                        name:
                          true,

                        email:
                          true,
                      },
                    },
                  },
                },

                transportJob: {
                  select: {
                    id:
                      true,

                    method:
                      true,

                    status:
                      true,

                    agreedAmount:
                      true,

                    truckOwnerId:
                      true,

                    truckOwner: {
                      select: {
                        id:
                          true,

                        name:
                          true,

                        email:
                          true,
                      },
                    },
                  },
                },
              },
            },
          },

          orderBy: {
            createdAt:
              'desc',
          },

          take: 500,
        });


      return res.json({
        commissions:
          entries,

        count:
          entries.length,

        total:
          money(
            entries.reduce(
              (
                sum,
                entry
              ) =>
                sum +
                Number(
                  entry.amount ||
                  0
                ),
              0
            )
          ),
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN COMMISSIONS ERROR:');

      return res.status(500).json({
        error:
          'Could not load commissions',
      });
    }
  }
);


// ============================================================================
// SELLER EARNINGS
// ============================================================================

router.get(
  '/seller-earnings',
  async (req, res) => {
    try {
      const entries =
        await prisma.paymentLedgerEntry.findMany({
          where: {
            type:
              'SELLER_EARNING',
          },

          include: {
            user: {
              select: {
                id:
                  true,

                name:
                  true,

                email:
                  true,
              },
            },

            payment: {
              include: {
                order: {
                  select: {
                    id:
                      true,

                    buyerId:
                      true,

                    sellerId:
                      true,

                    finalPrice:
                      true,

                    status:
                      true,
                  },
                },
              },
            },
          },

          orderBy: {
            createdAt:
              'desc',
          },

          take: 500,
        });


      const total =
        entries.reduce(
          (
            sum,
            entry
          ) =>
            sum +
            Number(
              entry.amount ||
              0
            ),
          0
        );


      return res.json({
        sellerEarnings:
          entries,

        count:
          entries.length,

        total:
          money(total),
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN SELLER EARNINGS ERROR:');

      return res.status(500).json({
        error:
          'Could not load seller earnings',
      });
    }
  }
);


// ============================================================================
// TRANSPORTER EARNINGS
// ============================================================================

router.get(
  '/transporter-earnings',
  async (req, res) => {
    try {
      const entries =
        await prisma.paymentLedgerEntry.findMany({
          where: {
            type:
              'TRANSPORTER_EARNING',
          },

          include: {
            user: {
              select: {
                id:
                  true,

                name:
                  true,

                email:
                  true,
              },
            },

            payment: {
              include: {
                transportJob: {
                  select: {
                    id:
                      true,

                    method:
                      true,

                    status:
                      true,

                    agreedAmount:
                      true,

                    truckOwnerId:
                      true,
                  },
                },

                order: {
                  select: {
                    id:
                      true,

                    buyerId:
                      true,

                    sellerId:
                      true,
                  },
                },
              },
            },
          },

          orderBy: {
            createdAt:
              'desc',
          },

          take: 500,
        });


      // Defensive filtering:
      //
      // Even if bad historical data exists, an OWN_TRUCK payment must never
      // be treated as transporter earnings.

      const filtered =
        entries.filter(
          (entry) =>
            entry.payment
              ?.transportJob
              ?.method ===
            'HIRE_TRANSPORTER'
        );


      const total =
        filtered.reduce(
          (
            sum,
            entry
          ) =>
            sum +
            Number(
              entry.amount ||
              0
            ),
          0
        );


      return res.json({
        transporterEarnings:
          filtered,

        count:
          filtered.length,

        total:
          money(total),
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN TRANSPORTER EARNINGS ERROR:');

      return res.status(500).json({
        error:
          'Could not load transporter earnings',
      });
    }
  }
);


// ============================================================================
// FINANCIAL LEDGER
// ============================================================================

router.get(
  '/ledger',
  async (req, res) => {
    try {
      const entries =
        await prisma.paymentLedgerEntry.findMany({
          include: {
            user: {
              select: {
                id:
                  true,

                name:
                  true,

                email:
                  true,
              },
            },

            payment: {
              select: {
                id:
                  true,

                orderId:
                  true,

                transportJobId:
                  true,

                type:
                  true,

                amount:
                  true,

                currency:
                  true,

                status:
                  true,

                reference:
                  true,

                provider:
                  true,

                commissionRate:
                  true,

                commissionAmount:
                  true,

                netAmount:
                  true,

                createdAt:
                  true,

                transportJob: {
                  select: {
                    method:
                      true,

                    agreedAmount:
                      true,

                    truckOwnerId:
                      true,
                  },
                },
              },
            },
          },

          orderBy: {
            createdAt:
              'desc',
          },

          take: 1000,
        });


      return res.json({
        entries,

        count:
          entries.length,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN LEDGER ERROR:');

      return res.status(500).json({
        error:
          'Could not load financial ledger',
      });
    }
  }
);


// ============================================================================
// ORDER FINANCIAL DETAILS
// ============================================================================

router.get(
  '/orders/:id/financials',
  async (req, res) => {
    try {
      const order =
        await prisma.order.findUnique({
          where: {
            id:
              req.params.id,
          },

          include: {
            buyer: {
              select: {
                id:
                  true,

                name:
                  true,

                email:
                  true,
              },
            },

            seller: {
              select: {
                id:
                  true,

                name:
                  true,

                email:
                  true,
              },
            },

            transportJob: {
              include: {
                truckOwner: {
                  select: {
                    id:
                      true,

                    name:
                      true,

                    email:
                      true,
                  },
                },

                truck: {
                  select: {
                    id:
                      true,

                    registration:
                      true,

                    truckType:
                      true,
                  },
                },
              },
            },

            payments: {
              include: {
                ledgerEntries:
                  true,
              },

              orderBy: {
                createdAt:
                  'desc',
              },
            },
          },
        });


      if (!order) {
        return res.status(404).json({
          error:
            'Order not found',
        });
      }


      const marketplacePayments =
        order.payments.filter(
          (payment) =>
            payment.type ===
            'MARKETPLACE'
        );


      const transportPayments =
        order.payments.filter(
          (payment) =>
            payment.type ===
            'TRANSPORT'
        );


      const commissions =
        order.payments.flatMap(
          (payment) =>
            payment.ledgerEntries.filter(
              (entry) =>
                entry.type ===
                'PLATFORM_COMMISSION'
            )
        );


      const sellerEarnings =
        order.payments.flatMap(
          (payment) =>
            payment.ledgerEntries.filter(
              (entry) =>
                entry.type ===
                'SELLER_EARNING'
            )
        );


      const transporterEarnings =
        order.payments.flatMap(
          (payment) =>
            payment.ledgerEntries.filter(
              (entry) =>
                entry.type ===
                'TRANSPORTER_EARNING'
            )
        );


      return res.json({
        order,

        marketplacePayments,

        transportPayments,

        commissions,

        sellerEarnings,

        transporterEarnings,

        totals: {
          marketplacePaid:
            money(
              marketplacePayments
                .filter(
                  (p) =>
                    p.status ===
                    'PAID'
                )
                .reduce(
                  (
                    sum,
                    p
                  ) =>
                    sum +
                    Number(
                      p.amount ||
                      0
                    ),
                  0
                )
            ),

          transportPaid:
            money(
              transportPayments
                .filter(
                  (p) =>
                    p.status ===
                    'PAID'
                )
                .reduce(
                  (
                    sum,
                    p
                  ) =>
                    sum +
                    Number(
                      p.amount ||
                      0
                    ),
                  0
                )
            ),

          platformCommission:
            money(
              commissions.reduce(
                (
                  sum,
                  entry
                ) =>
                  sum +
                  Number(
                    entry.amount ||
                    0
                  ),
                0
              )
            ),

          sellerEarnings:
            money(
              sellerEarnings.reduce(
                (
                  sum,
                  entry
                ) =>
                  sum +
                  Number(
                    entry.amount ||
                    0
                  ),
                0
              )
            ),

          transporterEarnings:
            money(
              transporterEarnings.reduce(
                (
                  sum,
                  entry
                ) =>
                  sum +
                  Number(
                    entry.amount ||
                    0
                  ),
                0
              )
            ),
        },
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN ORDER FINANCIALS ERROR:');

      return res.status(500).json({
        error:
          'Could not load order financial details',
      });
    }
  }
);


// ============================================================================
// LIST ALL USERS
// ============================================================================

router.get(
  '/users',
  async (req, res) => {
    try {
      const users =
        await prisma.user.findMany({
          select: {
            id:
              true,

            name:
              true,

            email:
              true,

            phone:
              true,

            roles:
              true,

            verificationStatus:
              true,

            accountStatus:
              true,

            rating:
              true,

            location:
              true,

            createdAt:
              true,

            updatedAt:
              true,
          },

          orderBy: {
            createdAt:
              'desc',
          },
        });


      return res.json({
        users,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN USERS ERROR:');

      return res.status(500).json({
        error:
          'Could not load users',
      });
    }
  }
);


// ============================================================================
// USER DETAILS
// ============================================================================

router.get(
  '/users/:id',
  async (req, res) => {
    try {
      const user =
        await prisma.user.findUnique({
          where: {
            id:
              req.params.id,
          },

          select: {
            id:
              true,

            name:
              true,

            email:
              true,

            phone:
              true,

            roles:
              true,

            verificationStatus:
              true,

            accountStatus:
              true,

            rating:
              true,

            location:
              true,

            createdAt:
              true,

            updatedAt:
              true,

            listings: {
              select: {
                id:
                  true,

                title:
                  true,

                status:
                  true,

                category:
                  true,

                createdAt:
                  true,
              },

              orderBy: {
                createdAt:
                  'desc',
              },

              take:
                50,
            },

            offersMade: {
              select: {
                id:
                  true,

                status:
                  true,

                amount:
                  true,

                createdAt:
                  true,
              },

              orderBy: {
                createdAt:
                  'desc',
              },

              take:
                50,
            },

            ordersAsBuyer: {
              select: {
                id:
                  true,

                status:
                  true,

                finalPrice:
                  true,

                createdAt:
                  true,
              },

              orderBy: {
                createdAt:
                  'desc',
              },

              take:
                50,
            },

            ordersAsSeller: {
              select: {
                id:
                  true,

                status:
                  true,

                finalPrice:
                  true,

                createdAt:
                  true,
              },

              orderBy: {
                createdAt:
                  'desc',
              },

              take:
                50,
            },

            disputesRaised: {
              select: {
                id:
                  true,

                status:
                  true,

                disputeType:
                  true,

                description:
                  true,

                createdAt:
                  true,
              },

              orderBy: {
                createdAt:
                  'desc',
              },

              take:
                50,
            },

            disputesAgainst: {
              select: {
                id:
                  true,

                status:
                  true,

                disputeType:
                  true,

                description:
                  true,

                createdAt:
                  true,
              },

              orderBy: {
                createdAt:
                  'desc',
              },

              take:
                50,
            },
          },
        });


      if (!user) {
        return res.status(404).json({
          error:
            'User not found',
        });
      }


      return res.json({
        user,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN USER DETAILS ERROR:');

      return res.status(500).json({
        error:
          'Could not load user details',
      });
    }
  }
);


// ============================================================================
// PROVIDER ROLE REQUESTS
// ============================================================================

router.get('/provider-role-requests', async (req, res) => {
  try {
    const requests = await prisma.providerRoleRequest.findMany({
      include: { user: { select: { id: true, name: true, email: true, roles: true, verificationStatus: true, accountStatus: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ requests });
  } catch (error) {
    req.log.error({ err: error }, 'ADMIN PROVIDER ROLE REQUESTS ERROR:');
    return res.status(500).json({ error: 'Could not load provider role requests' });
  }
});

router.patch('/provider-role-requests/:id', async (req, res) => {
  try {
    const { status, rejectionReason } = req.body || {};
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be APPROVED or REJECTED' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.providerRoleRequest.findUnique({ where: { id: req.params.id } });
      if (!request) {
        const error = new Error('Provider role request not found');
        error.statusCode = 404;
        throw error;
      }
      if (request.status !== 'PENDING') {
        const error = new Error('Provider role request has already been reviewed');
        error.statusCode = 409;
        throw error;
      }

      const updatedRequest = await tx.providerRoleRequest.update({
        where: { id: request.id },
        data: {
          status,
          reviewedById: req.user.id,
          reviewedAt: new Date(),
          rejectionReason: status === 'REJECTED' ? String(rejectionReason || '').trim().slice(0, 500) || null : null,
        },
      });

      if (status === 'APPROVED') {
        const user = await tx.user.findUnique({ where: { id: request.userId }, select: { roles: true } });
        const roles = Array.from(new Set([...(user?.roles || []), request.role]));
        await tx.user.update({
          where: { id: request.userId },
          data: { roles, verificationStatus: 'VERIFIED' },
        });
      }

      await recordAuditEvent(tx, {
        actorId: req.user.id,
        action: `PROVIDER_ROLE_REQUEST_${status}`,
        resourceType: 'ProviderRoleRequest',
        resourceId: request.id,
        metadata: { userId: request.userId, role: request.role, status },
      });
      return updatedRequest;
    });

    return res.json({ request: result });
  } catch (error) {
    req.log.error({ err: error }, 'ADMIN PROVIDER ROLE REVIEW ERROR:');
    return res.status(error.statusCode || 500).json({ error: error.message || 'Could not review provider role request' });
  }
});


// ============================================================================
// VERIFY USER
// ============================================================================

router.patch(
  '/users/:id/verify',
  async (req, res) => {
    try {
      const {
        verificationStatus,
      } = req.body;


      if (
        !VALID_VERIFICATION_STATUSES.includes(
          verificationStatus
        )
      ) {
        return res.status(400).json({
          error:
            'Invalid verification status',
        });
      }


      const user = await prisma.$transaction(async (tx) => {
        const before = await tx.user.findUnique({
          where: { id: req.params.id },
          select: { verificationStatus: true },
        });

        const updated = await tx.user.update({
          where: {
            id:
              req.params.id,
          },

          data: {
            verificationStatus,
          },

          select: {
            id:
              true,

            name:
              true,

            email:
              true,

            roles:
              true,

            verificationStatus:
              true,

            accountStatus:
              true,
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'ADMIN_USER_VERIFICATION_CHANGED',
          resourceType: 'User',
          resourceId: updated.id,
          metadata: {
            fromStatus: before?.verificationStatus || null,
            toStatus: verificationStatus,
          },
        });

        return updated;
      });


      return res.json({
        user,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN VERIFY USER ERROR:');

      return res.status(500).json({
        error:
          'Could not update verification status',
      });
    }
  }
);


// ============================================================================
// USER ACCOUNT STATUS
// ============================================================================

router.patch(
  '/users/:id/status',
  async (req, res) => {
    try {
      const {
        accountStatus,
      } = req.body;

      if (
        !VALID_ACCOUNT_STATUSES.includes(
          accountStatus
        )
      ) {
        return res.status(400).json({
          error:
            'Invalid account status',
        });
      }


      const targetId =
        req.params.id;


      if (
        targetId ===
          req.user.id &&
        accountStatus ===
          'SUSPENDED'
      ) {
        return res.status(400).json({
          error:
            'You cannot suspend your own account',
        });
      }


      if (
        accountStatus ===
        'SUSPENDED'
      ) {
        const target =
          await prisma.user.findUnique({
            where: {
              id:
                targetId,
            },

            select: {
              roles:
                true,
            },
          });


        if (!target) {
          return res.status(404).json({
            error:
              'User not found',
          });
        }


        if (
          target.roles.includes(
            'ADMIN'
          )
        ) {
          const adminCount =
            await prisma.user.count({
              where: {
                roles: {
                  has:
                    'ADMIN',
                },

                accountStatus:
                  'ACTIVE',
              },
            });


          if (
            adminCount <=
            1
          ) {
            return res.status(400).json({
              error:
                'Cannot suspend the last active administrator',
            });
          }
        }
      }


      const user = await prisma.$transaction(async (tx) => {
        const before = await tx.user.findUnique({
          where: { id: targetId },
          select: { accountStatus: true },
        });

        const updated = await tx.user.update({
          where: {
            id:
              targetId,
          },

          data: {
            accountStatus,
          },

          select: {
            id:
              true,

            name:
              true,

            email:
              true,

            roles:
              true,

            verificationStatus:
              true,

            accountStatus:
              true,
          },
        });

        if (accountStatus === 'SUSPENDED') {
          await revokeAllSessions(tx, updated.id, 'account-suspended');
        }

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'ADMIN_USER_ACCOUNT_STATUS_CHANGED',
          resourceType: 'User',
          resourceId: updated.id,
          metadata: {
            fromStatus: before?.accountStatus || null,
            toStatus: accountStatus,
          },
        });

        return updated;
      });


      return res.json({
        user,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN ACCOUNT STATUS ERROR:');

      return res.status(500).json({
        error:
          'Could not update account status',
      });
    }
  }
);


// ============================================================================
// ADD ROLE
// ============================================================================

router.patch(
  '/users/:id/roles/add',
  async (req, res) => {
    try {
      const {
        role,
      } = req.body;


      if (
        !VALID_ROLES.includes(
          role
        )
      ) {
        return res.status(400).json({
          error:
            'Invalid role',
        });
      }


      const user =
        await prisma.user.findUnique({
          where: {
            id:
              req.params.id,
          },

          select: {
            id:
              true,

            name:
              true,

            email:
              true,

            roles:
              true,
          },
        });


      if (!user) {
        return res.status(404).json({
          error:
            'User not found',
        });
      }


      if (
        user.roles.includes(
          role
        )
      ) {
        return res.status(400).json({
          error:
            `User already has the ${role} role`,
        });
      }


      const updatedUser = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
          where: {
            id:
              user.id,
          },

          data: {
            roles: [
              ...user.roles,
              role,
            ],
          },

          select: {
            id:
              true,

            name:
              true,

            email:
              true,

            roles:
              true,

            verificationStatus:
              true,

            accountStatus:
              true,
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'ADMIN_USER_ROLE_ADDED',
          resourceType: 'User',
          resourceId: updated.id,
          metadata: {
            role,
            rolesBefore: user.roles,
            rolesAfter: updated.roles,
          },
        });

        return updated;
      });


      return res.json({
        user:
          updatedUser,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN ADD ROLE ERROR:');

      return res.status(500).json({
        error:
          'Could not add role',
      });
    }
  }
);


// ============================================================================
// REMOVE ROLE
// ============================================================================

router.patch(
  '/users/:id/roles/remove',
  async (req, res) => {
    try {
      const {
        role,
      } = req.body;


      if (
        !VALID_ROLES.includes(
          role
        )
      ) {
        return res.status(400).json({
          error:
            'Invalid role',
        });
      }


      const targetId =
        req.params.id;


      const user =
        await prisma.user.findUnique({
          where: {
            id:
              targetId,
          },

          select: {
            id:
              true,

            name:
              true,

            email:
              true,

            roles:
              true,
          },
        });


      if (!user) {
        return res.status(404).json({
          error:
            'User not found',
        });
      }


      if (
        targetId ===
          req.user.id &&
        role ===
          'ADMIN'
      ) {
        return res.status(400).json({
          error:
            'You cannot remove your own ADMIN role',
        });
      }


      if (
        !user.roles.includes(
          role
        )
      ) {
        return res.status(400).json({
          error:
            `User does not have the ${role} role`,
        });
      }


      if (
        role ===
        'ADMIN'
      ) {
        const adminCount =
          await prisma.user.count({
            where: {
              roles: {
                has:
                  'ADMIN',
              },

              accountStatus:
                'ACTIVE',
            },
          });


        if (
          adminCount <=
          1
        ) {
          return res.status(400).json({
            error:
              'Cannot remove ADMIN role from the last active administrator',
          });
        }
      }


      const updatedRoles =
        user.roles.filter(
          (
            existingRole
          ) =>
            existingRole !==
            role
        );


      const updatedUser = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
          where: {
            id:
              targetId,
          },

          data: {
            roles:
              updatedRoles,
          },

          select: {
            id:
              true,

            name:
              true,

            email:
              true,

            roles:
              true,

            verificationStatus:
              true,

            accountStatus:
              true,
          },
        });

        await recordAuditEvent(tx, {
          actorId: req.user.id,
          action: 'ADMIN_USER_ROLE_REMOVED',
          resourceType: 'User',
          resourceId: updated.id,
          metadata: {
            role,
            rolesBefore: user.roles,
            rolesAfter: updated.roles,
          },
        });

        return updated;
      });


      return res.json({
        user:
          updatedUser,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN REMOVE ROLE ERROR:');

      return res.status(500).json({
        error:
          'Could not remove role',
      });
    }
  }
);


// ============================================================================
// FRAUD MONITORING
// ============================================================================

router.get(
  '/fraud-flags',
  async (req, res) => {
    try {
      const suspiciousUsers =
        await prisma.user.findMany({
          where: {
            disputesAgainst: {
              some: {
                status:
                  'OPEN',
              },
            },
          },

          include: {
            disputesAgainst: {
              where: {
                status:
                  'OPEN',
              },
            },
          },
        });


      return res.json({
        suspiciousUsers,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN FRAUD FLAGS ERROR:');

      return res.status(500).json({
        error:
          'Could not load fraud flags',
      });
    }
  }
);


// ============================================================================
// ORDER EVENTS / OPERATIONS FEED
// ============================================================================
//
// The OrderEvent stream is the durable workflow backbone.  Admins get a
// read-only operational view of recent customer-facing workflow events; the
// existing audit-events endpoint below remains the source for internal audit
// records.

router.get(
  '/order-events',
  async (req, res) => {
    try {
      const rawLimit = Number(req.query.limit || 100);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 250);

      const where = {};
      if (req.query.type) where.type = String(req.query.type);
      if (req.query.orderId) where.orderId = String(req.query.orderId);

      const events = await prisma.orderEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          actor: {
            select: { id: true, name: true, email: true },
          },
          order: {
            select: {
              id: true,
              status: true,
              finalPrice: true,
              buyer: { select: { id: true, name: true, email: true } },
              seller: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });

      return res.json({ events, count: events.length });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN ORDER EVENTS ERROR:');
      return res.status(500).json({ error: 'Could not load order events' });
    }
  }
);

// ============================================================================
// OPERATIONAL HEALTH SNAPSHOT
// ============================================================================

router.get(
  '/operations/summary',
  async (req, res) => {
    try {
      const [
        pendingPayments,
        reconciliationPayments,
        openDisputes,
        activeOrders,
        activeTransportJobs,
        recentEvents,
      ] = await Promise.all([
        prisma.payment.count({ where: { status: 'PENDING' } }),
        prisma.payment.count({ where: { status: 'RECONCILIATION_REQUIRED' } }),
        prisma.dispute.count({ where: { status: 'OPEN' } }),
        prisma.order.count({
          where: {
            status: { in: ['CONFIRMED', 'TRANSPORT_ARRANGED', 'IN_TRANSIT', 'DELIVERED'] },
          },
        }),
        prisma.transportJob.count({
          where: {
            status: { in: ['REQUESTED', 'QUOTED', 'ACCEPTED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED'] },
          },
        }),
        prisma.orderEvent.findMany({
          orderBy: { createdAt: 'desc' },
          take: 12,
          select: { id: true, orderId: true, type: true, fromStatus: true, toStatus: true, createdAt: true },
        }),
      ]);

      return res.json({
        queues: { pendingPayments, reconciliationPayments, openDisputes },
        activeOrders,
        activeTransportJobs,
        recentEvents,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN OPERATIONS SUMMARY ERROR:');
      return res.status(500).json({ error: 'Could not load operational summary' });
    }
  }
);

// ============================================================================
// FINANCIAL OPERATIONS: REFUNDS
// ============================================================================

router.get('/financial/refunds', async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const refunds = await prisma.paymentRefund.findMany({
      where: status ? { status } : {},
      include: {
        payment: { select: { id: true, type: true, amount: true, currency: true, status: true, orderId: true, provider: true, providerTransactionId: true } },
        requestedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return res.json({ refunds, count: refunds.length });
  } catch (error) {
    req.log.error({ err: error }, 'ADMIN REFUNDS ERROR:');
    return res.status(500).json({ error: 'Could not load refund queue' });
  }
});

router.patch('/financial/refunds/:id/complete', async (req, res) => {
  try {
    const refund = await prisma.$transaction((tx) => completeRefund(tx, {
      refundId: req.params.id,
      provider: req.body.provider || null,
      providerRefundId: req.body.providerRefundId || null,
      actorId: req.user.id,
      note: req.body.note || null,
    }));
    return res.json({ refund });
  } catch (error) {
    req.log.error({ err: error }, 'ADMIN COMPLETE REFUND ERROR:');
    return res.status(error.status || 500).json({ error: error.message || 'Could not complete refund' });
  }
});

router.patch('/financial/refunds/:id/fail', async (req, res) => {
  try {
    const refund = await prisma.$transaction((tx) => failRefund(tx, {
      refundId: req.params.id,
      failureReason: req.body.failureReason || 'Provider refund failed',
      actorId: req.user.id,
    }));
    return res.json({ refund });
  } catch (error) {
    req.log.error({ err: error }, 'ADMIN FAIL REFUND ERROR:');
    return res.status(error.status || 500).json({ error: error.message || 'Could not fail refund' });
  }
});

// Reconciliation dashboard — searchable across payment ID, order ID,
// customer, provider, provider transaction ID, expected/received amount,
// currency, status and a created-at date range (PDF section "Reconciliation
// dashboard"). `status` still defaults to OPEN so the queue view is
// unchanged for the common case; pass status=ALL to search across every
// status instead.
router.get('/financial/reconciliation', async (req, res) => {
  try {
    const {
      status: statusParam,
      paymentId,
      orderId,
      customer,
      provider,
      providerTransactionId,
      currency,
      minAmount,
      maxAmount,
      from,
      to,
    } = req.query;

    const status = statusParam ? String(statusParam) : 'OPEN';
    const where = {};

    if (status !== 'ALL') where.status = status;
    if (paymentId) where.paymentId = String(paymentId);
    if (provider) where.provider = { contains: String(provider), mode: 'insensitive' };
    if (currency) {
      where.OR = [
        { expectedCurrency: String(currency).toUpperCase() },
        { observedCurrency: String(currency).toUpperCase() },
      ];
    }

    const minAmountNum = minAmount !== undefined ? Number(minAmount) : null;
    const maxAmountNum = maxAmount !== undefined ? Number(maxAmount) : null;
    if (Number.isFinite(minAmountNum) || Number.isFinite(maxAmountNum)) {
      where.expectedAmount = {
        ...(Number.isFinite(minAmountNum) ? { gte: minAmountNum } : {}),
        ...(Number.isFinite(maxAmountNum) ? { lte: maxAmountNum } : {}),
      };
    }

    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(String(from)) } : {}),
        ...(to ? { lte: new Date(String(to)) } : {}),
      };
    }

    // Filters that live on the related Payment/Order/User rows can't be
    // expressed as plain `where` columns on PaymentReconciliation itself,
    // so they're applied via a `payment.is` relation filter instead.
    const paymentFilter = {};
    if (orderId) paymentFilter.orderId = String(orderId);
    if (providerTransactionId) paymentFilter.providerTransactionId = String(providerTransactionId);
    if (customer) {
      paymentFilter.createdBy = {
        OR: [
          { name: { contains: String(customer), mode: 'insensitive' } },
          { email: { contains: String(customer), mode: 'insensitive' } },
          { phone: { contains: String(customer), mode: 'insensitive' } },
        ],
      };
    }
    if (Object.keys(paymentFilter).length > 0) where.payment = { is: paymentFilter };

    const rawLimit = Number(req.query.limit || 500);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 500, 1), 500);

    const records = await prisma.paymentReconciliation.findMany({
      where,
      include: {
        payment: {
          select: {
            id: true, type: true, amount: true, currency: true, status: true,
            orderId: true, provider: true, providerTransactionId: true,
            createdBy: { select: { id: true, name: true, email: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return res.json({ records, count: records.length });
  } catch (error) {
    req.log.error({ err: error }, 'ADMIN RECONCILIATION ERROR');
    return res.status(500).json({ error: 'Could not load reconciliation queue' });
  }
});

router.patch('/financial/reconciliation/:id/resolve', async (req, res) => {
  try {
    const record = await resolveReconciliation({
      reconciliationId: req.params.id,
      status: req.body.status,
      actorId: req.user.id,
      note: req.body.note || null,
    });
    return res.json({ record });
  } catch (error) {
    req.log.error({ err: error }, 'ADMIN RESOLVE RECONCILIATION ERROR');
    return res.status(error.status || 500).json({ error: error.message || 'Could not resolve reconciliation' });
  }
});

// ============================================================================
// SELLER PAYOUTS
// ============================================================================
// Held/released/paid-out records tracking money the platform owes sellers
// after their MARKETPLACE payment settled. See sellerPayoutService.js.
// This does not move money — it is the worklist an ops person uses to know
// who is safe to pay (RELEASED) and to record that a transfer happened.

router.get('/payouts', async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const where = {};
    if (status && status !== 'ALL') {
      if (!['HELD', 'ON_HOLD_DISPUTE', 'RELEASED', 'PAID_OUT', 'CANCELLED'].includes(status)) {
        return res.status(400).json({ error: 'Invalid payout status filter' });
      }
      where.status = status;
    }

    const rawLimit = Number(req.query.limit || 200);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 200, 1), 500);

    const payouts = await prisma.sellerPayout.findMany({
      where,
      include: {
        seller: { select: { id: true, name: true, phone: true, email: true } },
        order: { select: { id: true, finalPrice: true, status: true, listing: { select: { cropType: true, title: true } } } },
      },
      orderBy: [{ status: 'asc' }, { releaseAt: 'asc' }],
      take: limit,
    });

    return res.json({ payouts, count: payouts.length });
  } catch (error) {
    req.log.error({ err: error }, 'ADMIN LIST PAYOUTS ERROR');
    return res.status(500).json({ error: 'Could not load seller payouts' });
  }
});

router.patch('/payouts/:id/pay-out', async (req, res) => {
  try {
    const payoutReference = typeof req.body?.payoutReference === 'string' ? req.body.payoutReference.trim().slice(0, 255) : null;

    const updated = await prisma.$transaction((tx) =>
      markPaidOut(tx, { payoutId: req.params.id, actorId: req.user.id, payoutReference })
    );

    return res.json({ payout: updated });
  } catch (error) {
    req.log.error({ err: error }, 'ADMIN MARK PAYOUT PAID ERROR');
    return res.status(error.status || 500).json({ error: error.message || 'Could not mark payout as paid out' });
  }
});

// ============================================================================
// EXPORT
// ============================================================================

// ============================================================================
// AUDIT EVENTS
// ============================================================================
// Admin-only read access to the append-only audit trail.

router.get(
  '/audit-events',
  async (req, res) => {
    try {
      const rawLimit = Number(req.query.limit || 50);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);

      const where = {};

      if (req.query.action) {
        where.action = String(req.query.action);
      }

      if (req.query.resourceType) {
        where.resourceType = String(req.query.resourceType);
      }

      if (req.query.resourceId) {
        where.resourceId = String(req.query.resourceId);
      }

      const events = await prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          actor: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      return res.json({
        events,
        count: events.length,
      });
    } catch (error) {
      req.log.error({ err: error }, 'ADMIN AUDIT EVENTS ERROR:');

      return res.status(500).json({
        error: 'Could not load audit events',
      });
    }
  }
);


module.exports = router;
