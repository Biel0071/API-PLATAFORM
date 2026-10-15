import { ProviderError } from '@api-platform/shared';
import { prisma } from '../lib/prisma';

interface AccountUsageWindow {
  calls: number;
  attempts: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  pricingConfigured: boolean;
  missingUsageAttempts: number;
  missingPricingAttempts: number;
  missingCostAttempts: number;
}

export async function getProviderAccountUsage(accountId: string, now = new Date()) {
  if (!accountId || accountId.length > 128 || !Number.isFinite(now.getTime())) {
    throw new ProviderError('provider-account', 'Invalid account usage request', 'VALIDATION_ERROR', 400, false);
  }
  const account = await prisma.providerAccount.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!account) throw new ProviderError('provider-account', 'Provider account not found', 'PROVIDER_ACCOUNT_NOT_FOUND', 404, false);
  const window = async (hours: number) => {
    const since = new Date(now.getTime() - hours * 3600_000);
    const rows = await prisma.$queryRaw<AccountUsageWindow[]>`
      SELECT COUNT(DISTINCT "correlationId")::integer AS "calls", COUNT(*)::integer AS "attempts",
        CASE WHEN COUNT("promptTokens") = COUNT(*) THEN COALESCE(SUM("promptTokens"), 0)::float8 ELSE NULL END AS "promptTokens",
        CASE WHEN COUNT("completionTokens") = COUNT(*) THEN COALESCE(SUM("completionTokens"), 0)::float8 ELSE NULL END AS "completionTokens",
        CASE WHEN COUNT("totalTokens") = COUNT(*) THEN COALESCE(SUM("totalTokens"), 0)::float8 ELSE NULL END AS "totalTokens",
        CASE WHEN COUNT("estimatedCost") = COUNT(*) THEN COALESCE(SUM("estimatedCost"), 0)::float8 ELSE NULL END AS "estimatedCost",
        COALESCE(BOOL_AND("pricingConfigured"), true) AS "pricingConfigured",
        COUNT(*) FILTER (WHERE "totalTokens" IS NULL)::integer AS "missingUsageAttempts",
        COUNT(*) FILTER (WHERE NOT "pricingConfigured")::integer AS "missingPricingAttempts"
        , COUNT(*) FILTER (WHERE "estimatedCost" IS NULL)::integer AS "missingCostAttempts"
      FROM "ProviderAttempt"
      WHERE "providerAccountId" = ${accountId} AND "createdAt" >= ${since} AND "createdAt" <= ${now}
    `;
    return rows[0];
  };
  const [last1h, last5h, last7d] = await Promise.all([window(1), window(5), window(7 * 24)]);
  return { accountId, asOf: now.toISOString(), last1h, last5h, last7d };
}
