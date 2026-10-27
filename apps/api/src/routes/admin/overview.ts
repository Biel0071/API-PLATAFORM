import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma';
import { registry } from '../../services/ai.service';
import { cacheService } from '../../services/cache.service';
import { queueStats } from '../../services/queue.service';

export async function overviewRoutes(secured: FastifyInstance): Promise<void> {
  // Visao geral (home do dashboard)
  secured.get('/overview', { schema: { tags: ['admin'] } }, async () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [tenants, apiKeys, users, requests24h, cached24h, tokens, cost, tokenUsageRows, queues, cache] =
      await Promise.all([
        prisma.tenant.count(),
        prisma.apiKey.count({ where: { active: true } }),
        prisma.user.count(),
        prisma.requestLog.count({ where: { createdAt: { gte: since } } }),
        prisma.requestLog.count({ where: { createdAt: { gte: since }, cached: true } }),
        prisma.requestLog.aggregate({
          where: { createdAt: { gte: since } },
          _sum: { totalTokens: true },
        }),
        prisma.requestLog.aggregate({
          where: { createdAt: { gte: since } },
          _sum: { cost: true },
        }),
        prisma.requestLog.groupBy({
          by: ['provider', 'tokenUsageSource'],
          where: { createdAt: { gte: since }, cached: false },
          _count: { id: true },
          _sum: { totalTokens: true, cost: true },
        }),
        queueStats(),
        ({} as any),
      ]);
    const usageByProvider = new Map<string, { requests: number; observedTokens: number; observedCalls: number; estimatedTokens: number; estimatedCalls: number; unreportedCalls: number; estimatedCost: number }>();
    let observedTokens = 0;
    let estimatedTokens = 0;
    let unreportedTokenCalls = 0;
    for (const row of tokenUsageRows) {
      const count = row._count.id;
      const tokens = row._sum.totalTokens ?? 0;
      const aggregate = usageByProvider.get(row.provider) ?? { requests: 0, observedTokens: 0, observedCalls: 0, estimatedTokens: 0, estimatedCalls: 0, unreportedCalls: 0, estimatedCost: 0 };
      aggregate.requests += count;
      aggregate.estimatedCost += row._sum.cost ?? 0;
      if (row.tokenUsageSource === 'observed') { observedTokens += tokens; aggregate.observedTokens += tokens; aggregate.observedCalls += count; }
      else if (row.tokenUsageSource === 'estimated') { estimatedTokens += tokens; aggregate.estimatedTokens += tokens; aggregate.estimatedCalls += count; }
      else if (row.tokenUsageSource === 'unknown') { unreportedTokenCalls += count; aggregate.unreportedCalls += count; }
      usageByProvider.set(row.provider, aggregate);
    }
    const avgDuration = await prisma.requestLog.aggregate({
      where: { createdAt: { gte: since }, cached: false },
      _avg: { durationMs: true },
    });
    const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const usageRows30d = prisma.usage?.findMany
      ? await prisma.usage.findMany({ where: { day: { gte: since30d } }, orderBy: { day: 'asc' } }).catch(() => [])
      : [];
    const usage30dByProvider = new Map<string, { requests: number; observedTokens: number; estimatedTokens: number; estimatedCost: number }>();
    const dailyMap = new Map<string, { day: string; requests: number; cachedHits: number; observedTokens: number; estimatedTokens: number; cost: number }>();
    let requests30d = 0;
    let cachedHits30d = 0;
    let observedTokens30d = 0;
    let estimatedTokens30d = 0;
    let cost30d = 0;
    for (const u of usageRows30d as any[]) {
      const dayKey = new Date(u.day).toISOString().slice(0, 10);
      const reqs = Number(u.requests ?? 0);
      const cached = Number(u.cachedHits ?? 0);
      const obs = Number(u.observedTokens ?? u.totalTokens ?? 0);
      const est = Number(u.estimatedTokens ?? 0);
      const c = Number(u.cost ?? 0);
      requests30d += reqs;
      cachedHits30d += cached;
      observedTokens30d += obs;
      estimatedTokens30d += est;
      cost30d += c;
      const cur = dailyMap.get(dayKey) ?? { day: dayKey, requests: 0, cachedHits: 0, observedTokens: 0, estimatedTokens: 0, cost: 0 };
      cur.requests += reqs;
      cur.cachedHits += cached;
      cur.observedTokens += obs;
      cur.estimatedTokens += est;
      cur.cost += c;
      dailyMap.set(dayKey, cur);
      const pAgg = usage30dByProvider.get(u.provider) ?? { requests: 0, observedTokens: 0, estimatedTokens: 0, estimatedCost: 0 };
      pAgg.requests += reqs;
      pAgg.observedTokens += obs;
      pAgg.estimatedTokens += est;
      pAgg.estimatedCost += c;
      usage30dByProvider.set(u.provider, pAgg);
    }
    const totals30d = {
      requests: Math.max(requests30d, requests24h),
      cachedHits: Math.max(cachedHits30d, cached24h),
      observedTokens: Math.max(observedTokens30d, observedTokens),
      estimatedTokens: Math.max(estimatedTokens30d, estimatedTokens),
      cost: Math.max(cost30d, cost._sum.cost ?? 0),
    };
    const dailySeries = Array.from(dailyMap.values());
    return {
      success: true,
      overview: {
        tenants,
        apiKeys,
        users,
        last24h: {
          requests: requests24h,
          cachedHits: cached24h,
          totalTokens: tokens._sum.totalTokens ?? 0,
          observedTokens,
          estimatedTokens,
          unreportedTokenCalls,
          cost: cost._sum.cost ?? 0,
          avgDurationMs: Math.round(avgDuration._avg.durationMs ?? 0),
        },
        totals30d,
        dailySeries,
        queues,
        cache,
        providers: registry.list().map((p) => ({ name: p.name, capabilities: p.capabilities, usage: usageByProvider.get(p.name) ?? { requests: 0, observedTokens: 0, observedCalls: 0, estimatedTokens: 0, estimatedCalls: 0, unreportedCalls: 0, estimatedCost: 0 }, usage30d: usage30dByProvider.get(p.name) ?? { requests: 0, observedTokens: 0, estimatedTokens: 0, estimatedCost: 0 } })),
      },
    };
  });
}
