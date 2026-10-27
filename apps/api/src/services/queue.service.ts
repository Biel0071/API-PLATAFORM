import { Queue, QueueEvents } from 'bullmq';
import { env } from '../config/env';
import { createBullConnection } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { cacheKey } from '@api-platform/shared';
import crypto from 'crypto';

export const QUEUE_NAMES = [
  'text',
  'vision',
  'image',
  'embedding',
  'ocr',
  'seo',
  'translation',
  'classification',
  'audio',
  'webhook',
  'orchestrator',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

const connection = createBullConnection();

const queues = new Map<QueueName, Queue>();
const queueEvents = new Map<QueueName, QueueEvents>();

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection,
      prefix: env.QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: name === 'image' ? 30_000 : name === 'vision' || name === 'ocr' ? 15_000 : 5_000 },
        removeOnComplete: { age: 3600, count: 1000 },
        // Mantem uma dead letter util sem deixar falhas crescerem para sempre
        // dentro do Redis. O historico duravel continua no Postgres.
        removeOnFail: { age: 7 * 24 * 3600, count: 2000 },
      },
    });
    queues.set(name, queue);
  }
  return queue;
}

export function getQueueEvents(name: QueueName): QueueEvents {
  let events = queueEvents.get(name);
  if (!events) {
    events = new QueueEvents(name, { connection: createBullConnection(), prefix: env.QUEUE_PREFIX });
    queueEvents.set(name, events);
  }
  return events;
}

export interface CallbackConfig {
  url: string;
  secret?: string;
}

export interface EnqueueOptions {
  tenantId?: string;
  projectId?: string;
  apiKeyId?: string;
  priority?: number;
  delayMs?: number;
  callback?: CallbackConfig;
  scopes?: string[];
  correlationId?: string;
}

export async function enqueue(
  name: QueueName,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<string> {
  const correlationId = opts.correlationId ?? crypto.randomUUID();
  const { callback: payloadCallback, execution: _execution, ...queuePayload } = payload;
  const selectedAccountId = typeof queuePayload.providerAccountId === 'string' ? queuePayload.providerAccountId : undefined;
  if (selectedAccountId) {
    const { registry, providerAccountPool } = await import('./ai.service');
    const capability = name === 'image' ? 'image' : name === 'vision' || name === 'ocr' ? 'vision' : name === 'embedding' ? 'embedding' : (name as string) === 'mission' ? 'mission' : 'chat';
    const requiredScopes = name === 'ocr' ? ['ocr'] : capability === 'embedding' ? ['embed'] : capability === 'mission' ? ['workflow'] : capability === 'chat' ? ['chat', 'text'] : [capability];
    if (!opts.scopes || (!opts.scopes.includes('*') && !requiredScopes.some((scope) => opts.scopes!.includes(scope)))) {
      throw Object.assign(new Error('API key lacks permission for this capability'), { status: 403, code: 'INSUFFICIENT_SCOPE' });
    }
    const account = await (registry.getAccountPool() ?? providerAccountPool).resolveAccount(selectedAccountId);
    if (!account || !account.enabled) throw Object.assign(new Error('Provider account not found or disabled'), { status: 404, code: 'PROVIDER_ACCOUNT_NOT_FOUND' });
    if (queuePayload.provider && queuePayload.provider !== account.providerName) throw Object.assign(new Error('Provider account does not match provider'), { status: 400, code: 'PROVIDER_ACCOUNT_MISMATCH' });
    if (!account.provider.capabilities.includes(capability)) throw Object.assign(new Error('Provider account does not support this capability'), { status: 400, code: 'CAPABILITY_NOT_SUPPORTED' });
    queuePayload.provider = account.providerName;
  }
  const callback = opts.callback ?? payloadCallback as CallbackConfig | undefined;
  const shouldDeduplicate = queuePayload.cache !== false;
  const dedupKey = shouldDeduplicate
    ? cacheKey('job', name, `${opts.tenantId ?? 'global'}:${opts.projectId ?? 'all'}`, queuePayload)
    : undefined;

  const data = {
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    queue: name,
    type: name,
    status: 'waiting',
    priority: opts.priority ?? 5,
    dedupKey,
    payload: { ...queuePayload, __correlationId: correlationId } as object,
  };

  let record: { id: string };
  if (dedupKey) {
    // Caminho rapido para cache hit: evita abrir uma transacao quando o job
    // ja existe. O advisory lock abaixo continua fechando a corrida no miss.
    const existing = await prisma.job.findFirst({
      where: { dedupKey, status: { in: ['waiting', 'active', 'completed'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (existing) return existing.id;

    const claimed = await prisma.$transaction(async (tx: any) => {
      // Serializa somente requests com o mesmo hash. Isso fecha a janela em
      // que um lote concorrente criava varios jobs iguais antes do primeiro
      // INSERT ficar visivel, desperdicando provider/tokens.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dedupKey}))`;
      const existing = await tx.job.findFirst({
        where: { dedupKey, status: { in: ['waiting', 'active', 'completed'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (existing) return { record: existing, created: false };
      return { record: await tx.job.create({ data, select: { id: true } }), created: true };
    });
    if (!claimed.created) return claimed.record.id;
    record = claimed.record;
  } else {
    record = await prisma.job.create({ data, select: { id: true } });
  }
  try {
    await getQueue(name).add(
      name,
      { ...queuePayload, __jobId: record.id, __tenantId: opts.tenantId, __projectId: opts.projectId, __callback: callback, __correlationId: correlationId },
      { jobId: record.id, priority: opts.priority ?? 5, delay: opts.delayMs },
    );
    return record.id;
  } catch (err) {
    const statusCode = (err as any)?.statusCode ?? (err as any)?.status;
    const errorCode = typeof (err as any)?.code === 'string' && /^[A-Z0-9_-]{1,64}$/i.test((err as any).code) ? (err as any).code : undefined;
    const safeError = typeof statusCode === 'number'
      ? `Queue dispatch failed (${statusCode})${errorCode ? `: ${errorCode}` : ''}`
      : errorCode ? `Queue dispatch failed: ${errorCode}` : 'Queue dispatch failed';
    await prisma.job.update({
      where: { id: record.id },
      data: { status: 'failed', error: safeError, finishedAt: new Date() },
    }).catch(() => undefined);
    throw err;
  }
}

/** Enfileira e aguarda o resultado (com timeout). */
export async function enqueueAndWait<T = unknown>(
  name: QueueName,
  payload: Record<string, unknown>,
  opts: EnqueueOptions & { timeoutMs?: number } = {},
): Promise<{ jobId: string; result: T }> {
  const jobId = await enqueue(name, payload, opts);
  const events = getQueueEvents(name);
  const job = await getQueue(name).getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found after enqueue`);
  const result = (await job.waitUntilFinished(events, opts.timeoutMs ?? env.JOB_WAIT_TIMEOUT_MS)) as T;
  return { jobId, result };
}

export async function queueStats(): Promise<
  Array<{ name: QueueName; waiting: number; active: number; completed: number; failed: number; delayed: number; prioritized: number;
    concurrency: number; averageJobMs: number; queued: number; estimatedDrainMs: number }>
> {
  return Promise.all(QUEUE_NAMES.map(async (name) => {
    const [counts, averageJobMs, concurrency] = await Promise.all([
      getQueue(name).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'),
      averageJobDuration(name),
      runtimeConcurrencyFor(name),
    ]);
    const queued = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
    
    // Update metric
    try {
      const { metrics } = require('../metrics');
      metrics.queueDepth.set({ queue: name }, counts.waiting ?? 0);
    } catch { /* ignore if metrics not available */ }

    return {
      name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      prioritized: counts.prioritized ?? 0,
      concurrency, averageJobMs, queued,
      estimatedDrainMs: Math.ceil(queued / concurrency) * averageJobMs,
    };
  }));
}

export async function closeQueues(): Promise<void> {
  await Promise.all([
    ...Array.from(queueEvents.values()).map((events) => events.close()),
    ...Array.from(queues.values()).map((queue) => queue.close()),
  ]);
  queueEvents.clear();
  queues.clear();
}
export interface QueueTiming {
  queue: QueueName;
  state: string;
  concurrency: number;
  position: number;
  jobsAhead: number;
  averageJobMs: number;
  estimatedWaitMs: number;
  estimatedCompletionMs: number;
  estimatedStartAt: string;
  estimatedFinishAt: string;
  approximate: true;
}

function concurrencyFor(name: QueueName): number {
  const configured = name === 'image'
    ? process.env.IMAGE_WORKER_CONCURRENCY ?? '1'
    : process.env.WORKER_CONCURRENCY ?? String(env.WORKER_CONCURRENCY);
  return Math.max(1, Number(configured) || 1);
}

async function runtimeConcurrencyFor(name: QueueName): Promise<number> {
  if (name === 'image') return concurrencyFor(name);
  const aliveSince = new Date(Date.now() - 120_000);
  const nodes = await prisma.workerNode.findMany({
    where: { lastHeartbeat: { gte: aliveSince } },
    select: { queues: true, concurrency: true },
  }).catch(() => []);
  const live = nodes
    .filter((node: typeof nodes[0]) => node.queues.split(',').includes(name))
    .reduce((total: number, node: typeof nodes[0]) => total + Math.max(1, node.concurrency), 0);
  return live || concurrencyFor(name);
}

function fallbackDurationFor(name: QueueName): number {
  if (name === 'webhook') return 1_000;
  if (name === 'image') return 35_000;
  if (name === 'ocr') return 15_000;
  return 7_000;
}

async function averageJobDuration(name: QueueName): Promise<number> {
  const recent = await prisma.job.findMany({
    where: { queue: name, status: 'completed', durationMs: { not: null } },
    orderBy: { finishedAt: 'desc' }, take: 20, select: { durationMs: true },
  });
  const durations = recent.map((job: typeof recent[0]) => job.durationMs as number | null)
    .filter((duration: number | null): duration is number => typeof duration === 'number' && duration > 0)
    .sort((a: number, b: number) => a - b);
  if (!durations.length) return fallbackDurationFor(name);
  const middle = Math.floor(durations.length / 2);
  return durations.length % 2 ? durations[middle] : Math.round((durations[middle - 1] + durations[middle]) / 2);
}

/** Estimativa operacional; prioridade e retries podem alterar a ordem real. */
export async function queueTiming(name: QueueName, jobId: string): Promise<QueueTiming> {
  const queue = getQueue(name);
  const [counts, averageJobMs, bullJob, concurrency] = await Promise.all([
    queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized'),
    averageJobDuration(name),
    queue.getJob(jobId),
    runtimeConcurrencyFor(name),
  ]);
  const state = bullJob ? await bullJob.getState() : 'unknown';
  const active = counts.active ?? 0;
  const waiting = counts.waiting ?? 0;
  const delayed = counts.delayed ?? 0;
  const prioritized = counts.prioritized ?? 0;
  const jobsAhead = state === 'completed' || state === 'failed' || state === 'active'
    ? 0 : Math.max(0, active + waiting + delayed + prioritized - 1);
  const position = state === 'completed' || state === 'failed' || state === 'active' ? 1 : jobsAhead + 1;
  const estimatedWaitMs = Math.ceil(jobsAhead / concurrency) * averageJobMs;
  const estimatedCompletionMs = estimatedWaitMs + averageJobMs;
  const now = Date.now();
  return {
    queue: name, state, concurrency, position, jobsAhead, averageJobMs,
    estimatedWaitMs, estimatedCompletionMs,
    estimatedStartAt: new Date(now + estimatedWaitMs).toISOString(),
    estimatedFinishAt: new Date(now + estimatedCompletionMs).toISOString(), approximate: true,
  };
}

export async function enqueueWithTiming(
  name: QueueName, payload: Record<string, unknown>, opts: EnqueueOptions = {},
): Promise<{ jobId: string; queue: QueueTiming }> {
  const jobId = await enqueue(name, payload, opts);
  const queue = await queueTiming(name, jobId);
  if (queue.state === 'unknown') {
    const record = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    if (record?.status) queue.state = record.status;
  }
  return { jobId, queue };
}

