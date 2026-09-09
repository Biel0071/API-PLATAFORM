import os from 'node:os';
import { prisma } from '../lib/prisma';
import { queueStats } from './queue.service';
import { registry } from './ai.service';
import { missionsService } from './missions.service';
import { agentsService } from './agents.service';
import { multiRepoService } from './multi-repo.service';
import { eventBus } from './event-bus.service';

export interface MonitoringDashboardData {
  system: {
    status: 'ONLINE' | 'DEGRADED' | 'CRITICAL';
    uptimeSeconds: number;
    cpuCores: number;
    memory: {
      totalMb: number;
      freeMb: number;
      usedMb: number;
      percentUsed: number;
    };
    nodeVersion: string;
    timestamp: string;
  };
  workers: {
    activeCount: number;
    nodes: Array<{
      hostname: string;
      queues: string;
      concurrency: number;
      lastHeartbeat: string;
      status: 'active' | 'stale';
    }>;
  };
  queues: {
    totalWaiting: number;
    totalActive: number;
    totalCompleted: number;
    totalFailed: number;
    details: Array<{
      name: string;
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    }>;
  };
  missions: {
    total: number;
    inProgress: number;
    completed: number;
    failed: number;
    recent: unknown[];
  };
  agents: {
    total: number;
    idle: number;
    working: number;
    list: unknown[];
  };
  repositories: {
    total: number;
    synced: number;
    list: unknown[];
  };
  aiUsage: {
    totalRequests24h: number;
    totalTokens24h: number;
    estimatedCost24h: number;
    avgLatencyMs: number;
    byProvider: Record<string, { requests: number; tokens: number; cost: number; avgLatencyMs: number }>;
  };
  recentEvents: unknown[];
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([
      promise.then((res) => {
        if (timer) clearTimeout(timer);
        return res;
      }).catch(() => {
        if (timer) clearTimeout(timer);
        return fallback;
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class CentralMonitoringService {
  private static instance: CentralMonitoringService;

  private constructor() {}

  public static getInstance(): CentralMonitoringService {
    if (!CentralMonitoringService.instance) {
      CentralMonitoringService.instance = new CentralMonitoringService();
    }
    return CentralMonitoringService.instance;
  }

  public async getDashboardData(): Promise<MonitoringDashboardData> {
    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const freeMem = Math.round(os.freemem() / 1024 / 1024);
    const usedMem = totalMem - freeMem;
    const since = new Date(Date.now() - 24 * 3600 * 1000);

    // Run independent queue, log, and worker queries in parallel bounded by timeout
    const [qStats, logs, workerNodes] = await Promise.all([
      withTimeout(queueStats().catch(() => []), 1500, []),
      withTimeout(
        prisma.requestLog.groupBy({
          by: ['provider'],
          where: { createdAt: { gte: since } },
          _count: { id: true },
          _sum: { totalTokens: true, cost: true },
          _avg: { durationMs: true },
        }).catch(() => []),
        1500,
        [],
      ),
      withTimeout(
        prisma.workerNode.findMany({
          orderBy: { lastHeartbeat: 'desc' },
          take: 20,
        }).catch(() => []),
        1500,
        [],
      ),
    ]);

    const totalWaiting = qStats.reduce((acc, q) => acc + (q.waiting || 0), 0);
    const totalActive = qStats.reduce((acc, q) => acc + (q.active || 0), 0);
    const totalCompleted = qStats.reduce((acc, q) => acc + (q.completed || 0), 0);
    const totalFailed = qStats.reduce((acc, q) => acc + (q.failed || 0), 0);

    // AI Usage in last 24h
    const byProvider: Record<string, { requests: number; tokens: number; cost: number; avgLatencyMs: number }> = {};
    let totalRequests24h = 0;
    let totalTokens24h = 0;
    let estimatedCost24h = 0;
    let avgLatencyMs = 0;

    for (const log of logs) {
      const reqs = log._count.id || 0;
      const tokens = log._sum.totalTokens || 0;
      const cost = Number((log._sum.cost || 0).toFixed(4));
      const latency = Math.round(log._avg.durationMs || 0);

      byProvider[log.provider] = {
        requests: reqs,
        tokens,
        cost,
        avgLatencyMs: latency,
      };

      totalRequests24h += reqs;
      totalTokens24h += tokens;
      estimatedCost24h += cost;
    }

    if (totalRequests24h > 0) {
      const totalDuration = Object.values(byProvider).reduce((acc, p) => acc + p.avgLatencyMs * p.requests, 0);
      avgLatencyMs = Math.round(totalDuration / totalRequests24h);
    }

    const nowMs = Date.now();
    const formattedWorkers = workerNodes.map((w: any) => ({
      hostname: w.hostname,
      queues: w.queues,
      concurrency: w.concurrency,
      lastHeartbeat: w.lastHeartbeat.toISOString(),
      status: nowMs - new Date(w.lastHeartbeat).getTime() < 60_000 ? ('active' as const) : ('stale' as const),
    }));

    // Missions & Agents
    const allMissions = missionsService.listMissions();
    const allAgents = agentsService.listAgents();
    const allRepos = multiRepoService.listRepositories();

    return {
      system: {
        status: 'ONLINE',
        uptimeSeconds: Math.round(process.uptime()),
        cpuCores: os.cpus().length,
        memory: {
          totalMb: totalMem,
          freeMb: freeMem,
          usedMb: usedMem,
          percentUsed: Math.round((usedMem / totalMem) * 100),
        },
        nodeVersion: process.version,
        timestamp: new Date().toISOString(),
      },
      workers: {
        activeCount: formattedWorkers.filter((w) => w.status === 'active').length || totalActive,
        nodes: formattedWorkers,
      },
      queues: {
        totalWaiting,
        totalActive,
        totalCompleted,
        totalFailed,
        details: qStats.map((q) => ({
          name: q.name,
          waiting: q.waiting || 0,
          active: q.active || 0,
          completed: q.completed || 0,
          failed: q.failed || 0,
        })),
      },
      missions: {
        total: allMissions.length,
        inProgress: allMissions.filter((m) => m.status === 'in_progress').length,
        completed: allMissions.filter((m) => m.status === 'completed').length,
        failed: allMissions.filter((m) => m.status === 'failed').length,
        recent: allMissions.slice(0, 5),
      },
      agents: {
        total: allAgents.length,
        idle: allAgents.filter((a) => a.status === 'idle').length,
        working: allAgents.filter((a) => a.status === 'working').length,
        list: allAgents,
      },
      repositories: {
        total: allRepos.length,
        synced: allRepos.filter((r) => r.status === 'synced').length,
        list: allRepos,
      },
      aiUsage: {
        totalRequests24h,
        totalTokens24h,
        estimatedCost24h: Number(estimatedCost24h.toFixed(4)),
        avgLatencyMs,
        byProvider,
      },
      recentEvents: eventBus.getHistory({ limit: 15 }),
    };
  }
}

export const centralMonitoringService = CentralMonitoringService.getInstance();
