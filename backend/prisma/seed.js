const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('password123', 10);

  const farmer = await prisma.user.create({
    data: { name: 'Alex Bekele', email: 'farmer@example.com', passwordHash, roles: ['BUYER','SELLER'], location: 'Bahir Dar' },
  });
  const buyer = await prisma.user.create({
    data: { name: 'Sara Tesfaye', email: 'buyer@example.com', passwordHash, roles: ['BUYER','SELLER'], location: 'Addis Ababa' },
  });
  const inspector = await prisma.user.create({
    data: { name: 'Dawit Alemu', email: 'inspector@example.com', passwordHash, roles: ['BUYER','SELLER','INSPECTOR'], location: 'Bahir Dar' },
  });
  const trucker = await prisma.user.create({
    data: { name: 'Yonas Girma', email: 'trucker@example.com', passwordHash, roles: ['BUYER','SELLER','TRUCK_OWNER'], location: 'Bahir Dar' },
  });
  await prisma.user.create({
    data: { name: 'Admin', email: 'admin@example.com', passwordHash, roles: ['BUYER','SELLER','ADMIN'], location: 'Addis Ababa' },
  });

  await prisma.listing.create({
    data: {
      sellerId: farmer.id,
      category: 'AGRICULTURAL',
      cropType: 'Potatoes',
      quantity: 500,
      unit: 'quintal',
      askingPrice: 250000,
      location: 'Bahir Dar',
      status: 'ACTIVE',
      harvestedDate: new Date(),
      photos: [],
    },
  });

  await prisma.truck.create({
    data: { ownerId: trucker.id, registration: 'AA-12345', truckType: 'Flatbed', capacity: 20, operatingArea: 'Bahir Dar - Addis Ababa' },
  });

  console.log('Seed complete. Demo logins (password: password123):');
  console.log('  farmer@example.com / buyer@example.com / inspector@example.com / trucker@example.com / admin@example.com');
}

main().finally(() => prisma.$disconnect());
