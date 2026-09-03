const express = require('express');
const prisma = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');

const router = express.Router();

router.use(authenticate, requireRole('ADMIN'));

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

/**
 * Admin overview
 */
router.get('/overview', async (req, res) => {
  const [
    users,
    listings,
    orders,
    disputes,
    activeAds,
    payments,
    suspendedUsers,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.listing.count(),
    prisma.order.count(),
    prisma.dispute.count({
      where: { status: 'OPEN' },
    }),
    prisma.advertisement.count({
      where: { status: 'ACTIVE' },
    }),
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { status: 'PAID' },
    }),
    prisma.user.count({
      where: { accountStatus: 'SUSPENDED' },
    }),
  ]);

  res.json({
    users,
    listings,
    orders,
    openDisputes: disputes,
    activeAds,
    suspendedUsers,
    totalPaidVolume: payments._sum.amount || 0,
  });
});

/**
 * List all users
 */
router.get('/users', async (req, res) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      roles: true,
      verificationStatus: true,
      accountStatus: true,
      rating: true,
      location: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  res.json({ users });
});

/**
 * Get one user's details and marketplace activity
 */
router.get('/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      roles: true,
      verificationStatus: true,
      accountStatus: true,
      rating: true,
      location: true,
      createdAt: true,
      updatedAt: true,

      listings: {
        select: {
          id: true,
          title: true,
          status: true,
          category: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 50,
      },

      offersMade: {
        select: {
          id: true,
          status: true,
          amount: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 50,
      },

      ordersAsBuyer: {
        select: {
          id: true,
          status: true,
          finalPrice: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 50,
      },

      ordersAsSeller: {
        select: {
          id: true,
          status: true,
          finalPrice: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 50,
      },

      disputesRaised: {
        select: {
          id: true,
          status: true,
          disputeType: true,
          description: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 50,
      },

      disputesAgainst: {
        select: {
          id: true,
          status: true,
          disputeType: true,
          description: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 50,
      },
    },
  });

  if (!user) {
    return res.status(404).json({
      error: 'User not found',
    });
  }

  res.json({ user });
});

/**
 * Change verification status
 */
router.patch('/users/:id/verify', async (req, res) => {
  const { verificationStatus } = req.body;

  if (!VALID_VERIFICATION_STATUSES.includes(verificationStatus)) {
    return res.status(400).json({
      error: 'Invalid verification status',
    });
  }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      verificationStatus,
    },
    select: {
      id: true,
      name: true,
      email: true,
      roles: true,
      verificationStatus: true,
      accountStatus: true,
    },
  });

  res.json({ user });
});

/**
 * Suspend or activate a user
 */
router.patch('/users/:id/status', async (req, res) => {
  const { accountStatus } = req.body;

  if (!VALID_ACCOUNT_STATUSES.includes(accountStatus)) {
    return res.status(400).json({
      error: 'Invalid account status',
    });
  }

  const targetId = req.params.id;

  // Admin cannot suspend themselves.
  if (
    targetId === req.user.id &&
    accountStatus === 'SUSPENDED'
  ) {
    return res.status(400).json({
      error: 'You cannot suspend your own account',
    });
  }

  // Protect the last remaining administrator.
  if (accountStatus === 'SUSPENDED') {
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { roles: true },
    });

    if (!target) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    if (target.roles.includes('ADMIN')) {
      const adminCount = await prisma.user.count({
        where: {
          roles: {
            has: 'ADMIN',
          },
          accountStatus: 'ACTIVE',
        },
      });

      if (adminCount <= 1) {
        return res.status(400).json({
          error: 'Cannot suspend the last active administrator',
        });
      }
    }
  }

  const user = await prisma.user.update({
    where: { id: targetId },
    data: {
      accountStatus,
    },
    select: {
      id: true,
      name: true,
      email: true,
      roles: true,
      verificationStatus: true,
      accountStatus: true,
    },
  });

  res.json({ user });
});

/**
 * Add a role to a user
 */
router.patch('/users/:id/roles/add', async (req, res) => {
  const { role } = req.body;

  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({
      error: 'Invalid role',
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      name: true,
      email: true,
      roles: true,
    },
  });

  if (!user) {
    return res.status(404).json({
      error: 'User not found',
    });
  }

  if (user.roles.includes(role)) {
    return res.status(400).json({
      error: `User already has the ${role} role`,
    });
  }

  const updatedRoles = [...user.roles, role];

  const updatedUser = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      roles: updatedRoles,
    },
    select: {
      id: true,
      name: true,
      email: true,
      roles: true,
      verificationStatus: true,
      accountStatus: true,
    },
  });

  res.json({ user: updatedUser });
});

/**
 * Remove a role from a user
 */
router.patch('/users/:id/roles/remove', async (req, res) => {
  const { role } = req.body;

  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({
      error: 'Invalid role',
    });
  }

  const targetId = req.params.id;

  const user = await prisma.user.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      name: true,
      email: true,
      roles: true,
    },
  });

  if (!user) {
    return res.status(404).json({
      error: 'User not found',
    });
  }

  // Prevent an admin from removing their own ADMIN role.
  if (
    targetId === req.user.id &&
    role === 'ADMIN'
  ) {
    return res.status(400).json({
      error: 'You cannot remove your own ADMIN role',
    });
  }

  if (!user.roles.includes(role)) {
    return res.status(400).json({
      error: `User does not have the ${role} role`,
    });
  }

  // Protect the last administrator.
  if (role === 'ADMIN') {
    const adminCount = await prisma.user.count({
      where: {
        roles: {
          has: 'ADMIN',
        },
        accountStatus: 'ACTIVE',
      },
    });

    if (adminCount <= 1) {
      return res.status(400).json({
        error: 'Cannot remove ADMIN role from the last active administrator',
      });
    }
  }

  const updatedRoles = user.roles.filter(
    (existingRole) => existingRole !== role
  );

  const updatedUser = await prisma.user.update({
    where: { id: targetId },
    data: {
      roles: updatedRoles,
    },
    select: {
      id: true,
      name: true,
      email: true,
      roles: true,
      verificationStatus: true,
      accountStatus: true,
    },
  });

  res.json({ user: updatedUser });
});

/**
 * Fraud monitoring
 */
router.get('/fraud-flags', async (req, res) => {
  const suspiciousUsers = await prisma.user.findMany({
    where: {
      disputesAgainst: {
        some: {
          status: 'OPEN',
        },
      },
    },
    include: {
      disputesAgainst: {
        where: {
          status: 'OPEN',
        },
      },
    },
  });

  res.json({ suspiciousUsers });
});

module.exports = router;
