import { ProviderAttemptRecord, ProviderAttemptTracker, providerAttemptData } from '@api-platform/shared';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export async function recordProviderAttempt(record: ProviderAttemptRecord): Promise<void> {
  await prisma.providerAttempt.create({ data: providerAttemptData(record) });
}

export const providerAttemptTracker = new ProviderAttemptTracker({
  loadPrices: (provider) => prisma.modelConfig.findMany({ where: { provider: { name: provider } } }),
  record: recordProviderAttempt,
  onError: () => logger.warn('provider attempt observation could not be persisted'),
});
