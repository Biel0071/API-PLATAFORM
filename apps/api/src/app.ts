import Fastify, { FastifyInstance } from 'fastify';
import path from 'node:path';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { fail, ProviderError } from '@api-platform/shared';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { registerAuth } from './plugins/auth';
import { registerSecurity } from './plugins/security';
import { registerSwagger } from './plugins/swagger';
import fastifyMultipart from '@fastify/multipart';
import { registryProm } from './metrics';
import { registry } from './services/ai.service';
import { v1Routes } from './routes/v1';
import { adminRoutes } from './routes/admin';
import { queueStats } from './services/queue.service';
import { registerOpenAICompatRoutes } from './routes/v1/openai-compat';
import { registerAnthropicCompatRoutes } from './routes/v1/anthropic-compat';
import { providerHealthState } from './services/health-check.service';

export async function buildApp(): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: logger as any,
    bodyLimit: env.MAX_UPLOAD_BYTES,
    requestTimeout: env.REQUEST_TIMEOUT_MS,
    // Socket fica ocioso (zero bytes) enquanto o provider gera a resposta (Ollama em
    // CPU pode levar 30-50s+). connectionTimeout precisa ser >= requestTimeout, senao
    // o Node mata o socket por inatividade antes do provider terminar (conexao cai
    // com "empty reply" mesmo dentro do requestTimeout configurado).
    connectionTimeout: env.REQUEST_TIMEOUT_MS,
    keepAliveTimeout: 72_000,
  }) as FastifyInstance;

  await registerSecurity(app);
  await registerAuth(app);
  await registerSwagger(app, env.DOCS_ENABLED);

  const maxVideoSize = Number(process.env.MAX_VIDEO_SIZE) || 50 * 1024 * 1024;
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: maxVideoSize,
    }
  });

  // ---------- Proteção Antecipada de Payload ----------
  app.addHook('preHandler', async (req, reply) => {
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const maxVideoSize = Number(process.env.MAX_VIDEO_SIZE) || 50 * 1024 * 1024; // Padrão de 50MB
      if (Number(contentLength) > maxVideoSize) {
        return reply.code(413).send(fail('PAYLOAD_TOO_LARGE', `Payload excede o limite estrito permitido de ${maxVideoSize} bytes.`));
      }
    }
  });

  // ---------- Tratamento de erros padrao ----------
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return reply.code(409).send(fail('CONFLICT', 'Já existe um registro com esse identificador'));
    }
    if (err instanceof ZodError) {
      return reply.code(400).send(fail('VALIDATION_ERROR', 'Payload invalido', err.flatten()));
    }
    if (err instanceof ProviderError) {
      return reply.code(err.statusCode).send(fail(err.code, err.message));
    }
    const statusCode = Number((err as { statusCode?: number }).statusCode ?? 500);
    if (statusCode === 429) {
      return reply.code(429).send(fail('RATE_LIMITED', 'Limite de requisicoes excedido'));
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(fail('REQUEST_ERROR', statusCode === 413 ? 'Payload excede o limite permitido' : err instanceof Error ? err.message : 'Requisicao invalida'));
    }
    app.log.error(err);
    return reply.code(500).send(fail('INTERNAL_ERROR', 'Erro interno'));
  });

  const getHealthPayload = async () => {
    const requestStart = Date.now();
    const checks: Record<string, boolean | string | number | any> = {};
    
    // Core Dependencies & Queue Metrics probed in parallel with strict timeout
    checks.api = true;
    const probeTimeout = 1500;
    const probeWithTimeout = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), probeTimeout);
      });
      try {
        return await Promise.race([
          p.then((res) => {
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
    };

    const [pgOk, redisOk, qStats, workerCount] = await Promise.all([
      probeWithTimeout(prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false), false),
      probeWithTimeout(redis.ping().then((res) => res === 'PONG').catch(() => false), false),
      probeWithTimeout(queueStats().catch(() => null), null),
      probeWithTimeout(prisma.workerNode.count({ where: { lastHeartbeat: { gt: new Date(Date.now() - 60000) } } }).catch(() => null), null),
    ]);

    checks.postgres = pgOk;
    checks.redis = redisOk;

    if (qStats) {
      const qDepth = qStats.reduce((acc, q) => acc + (q.waiting || 0), 0);
      const activeCount = qStats.reduce((acc, q) => acc + (q.active || 0), 0);
      checks.queue = { waiting: qDepth, active: activeCount };
    } else {
      checks.queue = 'Standby';
    }
    checks.workers = workerCount;

    // Extended Infra Checks. ssl reflete a presença real de um proxy TLS na
    // frente (o deploy seta SSL_ENABLED=true quando o Caddy sobe), não uma
    // inferência por NODE_ENV. docker/icp seguem env explícita quando houver.
    checks.dashboard = null;
    checks.mongo = 'N/A';
    checks.docker = process.env.DOCKER_ENV === 'true' ? true : null;
    checks.ssl = process.env.SSL_ENABLED === 'true';
    checks.icp = null;
    
    // Capabilities Status
    checks.mission = true;
    checks.streaming = true;
    checks.retry = true;
    checks.fallback = true;
    
    // System Metrics
    const os = require('os');
    const memory = {
      total: Math.round(os.totalmem() / 1024 / 1024),
      free: Math.round(os.freemem() / 1024 / 1024),
    };
    checks.memory = memory;
    checks.cpu = os.cpus().length;
    checks.disk = null;
    checks.version = '1.0.0-enterprise';

    const deepProviderHealth = process.env.DEEP_PROVIDER_HEALTH === 'true';
    const providerDetails: Record<string, any> = {};
    for (const p of registry.list()) {
      if (!deepProviderHealth) {
        const measured = providerHealthState.get(p.name);
        const fresh = measured && Date.now() - measured.lastCheck < 120000;
        providerDetails[p.name] = {
          online: fresh ? measured.status === 'healthy' : null,
          latency: fresh ? measured.latency : null,
          models: [],
          message: fresh ? 'background provider probe' : 'provider probe pending or stale',
          status: fresh ? (measured.status === 'healthy' ? 'ONLINE' : 'OFFLINE') : 'UNKNOWN',
          checkedAt: measured ? new Date(measured.lastCheck).toISOString() : null,
        };
        continue;
      }

      try {
        const start = Date.now();
        const health = await p.health();
        const latency = Date.now() - start;
        let models: string[] = [];
        try {
          models = (await p.models()).map((m) => m.id);
        } catch { /* ignore */ }
        providerDetails[p.name] = {
          online: health.ok,
          latency: health.latencyMs ?? latency,
          models,
          message: health.message,
          status: health.ok ? 'ONLINE' : 'OFFLINE',
          cost: 0,
          tokens: 0,
          requests: 0,
          score: 1.0, // base score
          fallback: true
        };
      } catch (err) {
        providerDetails[p.name] = { online: false, error: err instanceof Error ? err.message : String(err), status: 'OFFLINE' };
      }
    }

    checks.providers = providerDetails;

    checks.latency = Date.now() - requestStart;

    const healthy = checks.postgres && checks.redis;

    return {
      success: healthy,
      status: healthy ? 'ONLINE' : 'DEGRADED',
      runtime: 'api-platform-Engine',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      ...checks
    };
  };

  // ---------- Health (publico) ----------
  app.get('/v1/health', { schema: { tags: ['system'] } }, getHealthPayload);

  app.get('/health', { schema: { tags: ['system'] } }, getHealthPayload);
  app.get('/ready', { schema: { tags: ['system'] } }, async (_request, reply) => {
    const health = await getHealthPayload();
    return reply.code(health.success ? 200 : 503).send(health);
  });

  // Operational capacity projection: names and counters only, never credentials.
  app.get('/system/ai-capacity', { schema: { tags: ['system'] } }, async () => {
    const providers = await Promise.all(registry.list().map(async (provider) => {
      const started = Date.now();
      try {
        // Ollama health performs one real token generation; allow cold model load.
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('provider probe timeout')), Number(process.env.PROVIDER_HEALTH_TIMEOUT_MS || 25_000)));
        const health = await Promise.race([provider.health(), timeout]);
        const models = await provider.models().catch(() => []);
        return { name: provider.name, status: health.ok ? 'healthy' : 'offline', health: health.ok, latencyMs: health.latencyMs ?? Date.now() - started, models: models.map((model) => model.id), capabilities: provider.capabilities };
      } catch (error) {
        return { name: provider.name, status: 'offline', health: false, latencyMs: Date.now() - started, models: [], capabilities: provider.capabilities, error: error instanceof Error ? error.message : 'provider probe failed' };
      }
    }));
    const queues = await queueStats().catch(() => []);
    const queuedRequests = queues.reduce((sum, queue) => sum + Number(queue.waiting || 0), 0);
    const activeRequests = queues.reduce((sum, queue) => sum + Number(queue.active || 0), 0);
    return { success: true, providers, healthyProviders: providers.filter((provider) => provider.health).map((provider) => provider.name), keys: { configured: 'redacted', healthy: 'redacted' }, activeRequests, queuedRequests, availableConcurrency: Math.max(0, Number(process.env.MAX_GLOBAL_AI_CONCURRENCY || 8) - activeRequests), timestamp: new Date().toISOString() };
  });


  // ---------- Metricas Prometheus ----------
  if (env.METRICS_ENABLED) {
    app.get('/metrics', { schema: { tags: ['system'] } }, async (req, reply) => {
      // Se METRICS_TOKEN estiver definido, exige-o (Bearer ou x-metrics-token).
      // Sem token configurado, mantem aberto (assume rede interna/firewall).
      if (env.METRICS_TOKEN) {
        const auth = req.headers.authorization;
        const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
        const provided = bearer ?? (req.headers['x-metrics-token'] as string | undefined);
        if (provided !== env.METRICS_TOKEN) {
          return reply.code(401).send(fail('UNAUTHORIZED', 'metrics token invalido ou ausente'));
        }
      }
      reply.header('content-type', registryProm.contentType);
      return registryProm.metrics();
    });
  }

  // ---------- Rotas ----------
  await app.register(registerOpenAICompatRoutes);
  await app.register(registerAnthropicCompatRoutes);
  await app.register(v1Routes, { prefix: '/v1' });
  await app.register(adminRoutes, { prefix: '/admin' });

  app.get('/', async (_req, reply) => reply.send({ status: 'API Platform Gateway' }));

  return app;
}
