const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
(async () => {
  const mode = process.argv[2];
  if (mode === 'create') {
    const email = `fenix-qa-${crypto.randomBytes(8).toString('hex')}@example.invalid`;
    const password = crypto.randomBytes(24).toString('base64url');
    await prisma.user.create({ data: { email, name: 'Fenix Browser QA', role: 'admin', active: true, passwordHash: await bcrypt.hash(password, 10) } });
    process.stdout.write(JSON.stringify({ ADMIN_EMAIL: email, ADMIN_PASSWORD: password }));
  } else if (mode === 'delete') {
    const email = process.argv[3];
    if (!/^fenix-qa-[a-f0-9]{16}@example\.invalid$/.test(email || '')) throw new Error('Invalid QA account');
    const result = await prisma.user.deleteMany({ where: { email } });
    process.stdout.write(JSON.stringify({ deleted: result.count }));
  } else throw new Error('Expected create or delete');
})().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
