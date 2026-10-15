import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { reloadRegistryAfterMutation } from '../../services/ai.service';
import { testProviderAccountHealth } from '../../services/provider-account-runtime.service';
import { finalizeLegacyProviderSecrets } from '../../services/provider-account-migration.service';
import { getProviderAccountUsage } from '../../services/provider-account-usage.service';
import {
  createProviderAccount,
  disconnectProviderAccount,
  listProviderAccounts,
  providerAccountInputSchema,
  providerAccountUpdateSchema,
  providerNameSchema,
  updateProviderAccount,
} from '../../services/provider-account.service';

export async function providerAccountsRoutes(secured: FastifyInstance): Promise<void> {
  secured.get('/provider-accounts/:accountId/usage', { schema: { tags: ['admin'] } }, async (req) => {
    const { accountId } = z.object({ accountId: z.string().min(1).max(128) }).parse(req.params);
    return { success: true, usage: await getProviderAccountUsage(accountId) };
  });
  secured.get('/provider-accounts', { schema: { tags: ['admin'] } }, async (req) => {
    const query = z
      .object({ providerName: providerNameSchema.optional() })
      .strict()
      .parse(req.query);
    return { success: true, accounts: await listProviderAccounts(query.providerName) };
  });
  secured.post('/provider-accounts', { schema: { tags: ['admin'] } }, async (req, reply) => {
    const account = await createProviderAccount(providerAccountInputSchema.parse(req.body));
    await reloadRegistryAfterMutation();
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.account.created', target: account.id },
    });
    return reply.code(201).send({ success: true, account });
  });
  secured.patch('/provider-accounts/:accountId', { schema: { tags: ['admin'] } }, async (req) => {
    const { accountId } = z.object({ accountId: z.string().min(1).max(128) }).parse(req.params);
    const account = await updateProviderAccount(
      accountId,
      providerAccountUpdateSchema.parse(req.body),
    );
    await reloadRegistryAfterMutation();
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.account.updated', target: account.id },
    });
    return { success: true, account };
  });
  secured.delete('/provider-accounts/:accountId', { schema: { tags: ['admin'] } }, async (req) => {
    const { accountId } = z.object({ accountId: z.string().min(1).max(128) }).parse(req.params);
    await disconnectProviderAccount(accountId);
    await reloadRegistryAfterMutation();
    await prisma.auditLog.create({
      data: { userId: req.user.sub, action: 'provider.account.disconnected', target: accountId },
    });
    return { success: true };
  });
  secured.post(
    '/provider-accounts/:accountId/test',
    { schema: { tags: ['admin'] } },
    async (req) => {
      const { accountId } = z.object({ accountId: z.string().min(1).max(128) }).parse(req.params);
      const health = await testProviderAccountHealth(accountId);
      if (health.ok) await finalizeLegacyProviderSecrets();
      await reloadRegistryAfterMutation();
      await prisma.auditLog.create({
        data: { userId: req.user.sub, action: 'provider.account.health-tested', target: accountId },
      });
      return { success: true, health };
    },
  );
}
