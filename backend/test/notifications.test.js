'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Notification integration tests require the same disposable database setup
// as the marketplace E2E suite. They remain opt-in so ordinary `npm test`
// never touches a developer or production database.

test('notification integration suite is opt-in', async () => {
  if (process.env.MARKETBRIDGE_E2E !== '1' || !process.env.E2E_DATABASE_URL) {
    assert.ok(true);
    return;
  }

  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;

  const prisma = require('../src/config/db');
  const { recordOrderEvent } = require('../src/services/orderEventService');
  const { listNotifications } = require('../src/services/notificationService');

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const seller = await prisma.user.create({
    data: {
      name: `Notification Seller ${suffix}`,
      email: `notification-seller-${suffix}@example.com`,
      passwordHash: 'test-only',
    },
  });
  const buyer = await prisma.user.create({
    data: {
      name: `Notification Buyer ${suffix}`,
      email: `notification-buyer-${suffix}@example.com`,
      passwordHash: 'test-only',
    },
  });

  let order;
  try {
    const listing = await prisma.listing.create({
      data: {
        sellerId: seller.id,
        title: `Notification Listing ${suffix}`,
        description: 'Notification integration fixture',
        category: 'PRODUCT',
        askingPrice: 100,
        unit: 'item',
        quantity: 1,
        location: 'Addis Ababa',
        status: 'ACTIVE',
      },
    });

    order = await prisma.order.create({
      data: {
        listingId: listing.id,
        buyerId: buyer.id,
        sellerId: seller.id,
        finalPrice: 100,
        status: 'PENDING_PAYMENT',
      },
    });

    await prisma.$transaction(async (tx) => {
      await recordOrderEvent(tx, {
        orderId: order.id,
        actorId: buyer.id,
        type: 'ORDER_CREATED',
      });
    });

    const sellerInbox = await listNotifications(prisma, seller.id);
    assert.equal(sellerInbox.notifications.length, 1);
    assert.equal(sellerInbox.notifications[0].orderEventId != null, true);
    assert.equal(sellerInbox.notifications[0].orderId, order.id);
    assert.equal(sellerInbox.unreadCount, 1);

    const buyerInbox = await listNotifications(prisma, buyer.id);
    assert.equal(buyerInbox.notifications.length, 0, 'event actor should not receive an echo notification');

    const event = await prisma.orderEvent.findFirst({ where: { orderId: order.id } });
    assert.ok(event);

    const notificationCount = await prisma.notification.count({ where: { orderEventId: event.id } });
    assert.equal(notificationCount, 1);
  } finally {
    if (order) {
      await prisma.notification.deleteMany({ where: { orderId: order.id } });
      await prisma.orderEvent.deleteMany({ where: { orderId: order.id } });
      await prisma.order.delete({ where: { id: order.id } });
    }
    await prisma.listing.deleteMany({ where: { sellerId: seller.id, title: `Notification Listing ${suffix}` } });
    await prisma.user.deleteMany({ where: { id: { in: [seller.id, buyer.id] } } });
    await prisma.$disconnect();
    if (previousDatabaseUrl) process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
