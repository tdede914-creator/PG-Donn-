/**
 * Seed admin user awal berdasarkan .env
 *   ADMIN_USERNAME, ADMIN_PASSWORD
 */

const bcrypt = require('bcryptjs');
const prisma = require('../db');
const config = require('../config');

async function main() {
  const { username, password } = config.admin;
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.log(`[seed] admin '${username}' sudah ada, skip.`);
    return;
  }
  await prisma.user.create({
    data: {
      username,
      passwordHash: bcrypt.hashSync(password, 10),
    },
  });
  console.log(`[seed] admin created: ${username} / ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
