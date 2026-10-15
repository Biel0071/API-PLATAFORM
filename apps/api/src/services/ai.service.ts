import {
  AIProvider,
  deterministicTextQuality,
  Capability,
  createRegistryFromEnv,
  ok,
  pickModel,
  ProviderRegistry,
  ProviderError,
  ProviderCircuitBreaker,
  ProviderResult,
  QualityGateError,
  StandardResponse,
  TaskHint,
  createProviderAttemptContext,
} from '@api-platform/shared';
import {
  ProviderAccountPool,
  ProviderAccountTarget,
  resolveProviderAccountTargets,
} from '@api-platform/shared';
import { cacheService } from './cache.service';
import { usageService } from './usage.service';
import { metrics } from '../metrics';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { buildProviderEnv } from './provider-config.service';
import { loadProviderAccountRuntime } from './provider-account-runtime.service';
import { redis } from '../lib/redis';
import { providerAttemptTracker } from './provider-attempt.service';
import { recallExecutionRoute, rememberExecutionSuccess } from './execution-memory.service';

export let registry: ProviderRegistry = createRegistryFromEnv(process.env);
const localAccountRotation = new Map<string, number>();
export let providerAccountPool = new ProviderAccountPool(
  async () => [],
  async () => 0,
);
let registryUpdatedAt = 0;
let registryReload: Promise<ProviderRegistry> | undefined;

export async function reloadRegistry(): Promise<ProviderRegistry> {
  if (!registryReload) {
    registryReload = buildProviderEnv()
      .then((merged) => {
        registry = createRegistryFromEnv(merged);
        return loadProviderAccountRuntime(registry, async (providerName, count) => {
          try {
            const next = await redis.incr(`provider:account:round-robin:${providerName}`);
            return (next - 1) % count;
          } catch {
            const next = (localAccountRotation.get(providerName) ?? 0) + 1;
            localAccountRotation.set(providerName, next);
            return (next - 1) % count;
          }
        });
      })
      .then((runtime) => {
        registry = runtime.registry;
        providerAccountPool = runtime.pool;
        registryUpdatedAt = Date.now();
        return registry;
      })
      .finally(() => {
        registryReload = undefined;
      });
  }
  return registryReload;
}

/** Force a registry read after a persisted provider credential mutation. */
export async function reloadRegistryAfterMutation(): Promise<ProviderRegistry> {
  const reloadAlreadyInProgress = registryReload;
  if (reloadAlreadyInProgress) await reloadAlreadyInProgress.catch(() => undefined);
  return reloadRegistry();
}

async function refreshOAuthRegistryIfNeeded(): Promise<void> {
  if (!process.env.GEMINI_OAUTH_CLIENT_ID && !process.env.HUGGINGFACE_OAUTH_CLIENT_ID) return;
  if (Date.now() - registryUpdatedAt < 30_000) return;
  await reloadRegistry();
}

export interface ExecuteContext {
  correlationId?: string;
  executionId?: string;
  tenantId?: string;
  projectId?: string;
  apiKeyId?: string;
  cache?: boolean;
  providerAccountId?: string;
  scopes?: string[];
}

function capabilityScopes(capability: Capability): string[] {
  if (capability === 'embedding') return ['embed'];
  if (capability === 'image') return ['image'];
  if (capability === 'vision') return ['vision'];
  if (capability === 'mission') return ['workflow'];
  if (capability === 'chat') return ['chat', 'text'];
  return ['chat'];
}

function canFailOver(error: unknown): boolean {
  const value = error as { status?: number; statusCode?: number; retryable?: boolean; code?: string };
  const status = value?.statusCode ?? value?.status;
  if (typeof status === 'number') return status === 408 || status === 425 || status === 429 || status >= 500;
  return value?.retryable === true || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(value?.code ?? '');
}

export const fallbackOrder = (
  process.env.FREE_PROVIDER_ORDER ?? 'groq,openrouter,cloudflare,ollama,lmstudio'
)
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const inFlight = new Map<string, Promise<ProviderResult<unknown>>>();
export const providerCircuit = new ProviderCircuitBreaker(
  Math.max(1, Number(process.env.PROVIDER_FAILURE_THRESHOLD ?? 2)),
  Math.max(1_000, Number(process.env.PROVIDER_COOLDOWN_MS ?? 30_000)),
);

function enforceSynchronousQuality<T>(
  response: StandardResponse<T>,
  capability: Capability,
  request: Record<string, unknown>,
): StandardResponse<T> {
  if (capability === 'embedding') return response;
  const threshold = Math.max(
    0,
    Math.min(100, Number(request.minQuality ?? process.env.MIN_OUTPUT_QUALITY ?? 90)),
  );
  const result = response.result as any;
  const text =
    typeof result === 'string'
      ? result
      : typeof result?.text === 'string'
        ? result.text
        : typeof result?.message?.content === 'string'
          ? result.message.content
          : undefined;
  let quality;
  if (typeof text === 'string') {
    quality = deterministicTextQuality(text, threshold, {
      jsonExpected: request.json === true,
      shortAnswer: request.json !== true,
    });
  } else if (Array.isArray(result?.images)) {
    const valid =
      result.images.length > 0 &&
      result.images.every(
        (image: any) => (image?.base64?.length ?? 0) > 4_096 || Boolean(image?.url),
      );
    quality = {
      score: valid ? 100 : 30,
      threshold,
      passed: valid ? 100 >= threshold : 30 >= threshold,
      method: 'deterministic' as const,
      issues: valid ? [] : ['missing_or_too_small_image'],
    };
  }
  if (!quality) return response;
  response.quality = quality;
  if (
    request.strictQuality !== false &&
    process.env.QUALITY_GATE_STRICT !== 'false' &&
    !quality.passed
  ) {
    throw new QualityGateError(quality);
  }
  return response;
}
/** Pipeline central: cache por provider -> chamada -> fallback -> uso. */
export async function execute<T>(
  capability: Capability,
  request: {
    provider?: string;
    providerAccountId?: string;
    model?: string;
    fallback?: boolean;
    [key: string]: unknown;
  },
  call: (provider: AIProvider, providerInput?: Record<string, unknown>) => Promise<ProviderResult<T>>,
  ctx: ExecuteContext = {},
): Promise<StandardResponse<T>> {
  const attemptContext = createProviderAttemptContext(ctx);
  await refreshOAuthRegistryIfNeeded();
  const clientModel = request.model;
  const selectedAccountId = ctx.providerAccountId ?? request.providerAccountId;
  let effectiveRequest = { ...request };
  if (selectedAccountId) {
    const requiredScopes = capabilityScopes(capability);
    if ((ctx.tenantId || ctx.apiKeyId) && (!ctx.scopes || (!ctx.scopes.includes('*') && !requiredScopes.some((scope) => ctx.scopes!.includes(scope))))) {
      throw new ProviderError(
        'gateway',
        'API key lacks permission for this capability',
        'INSUFFICIENT_SCOPE',
        403,
        false,
      );
    }
    const accountPool = registry.getAccountPool() ?? providerAccountPool;
    const selected = await accountPool.resolveAccount(selectedAccountId);
    if (!selected || !selected.enabled) {
      throw new ProviderError(
        'provider-account',
        'selected provider account was not found or is disabled',
        'PROVIDER_ACCOUNT_NOT_FOUND',
        404,
        false,
      );
    }
    if (request.provider && request.provider !== selected.providerName) {
      throw new ProviderError(
        request.provider,
        'selected account belongs to a different provider',
        'PROVIDER_ACCOUNT_MISMATCH',
        400,
        false,
      );
    }
    if (!selected.provider.capabilities.includes(capability)) {
      throw new ProviderError(
        selected.providerName,
        `selected account does not support capability "${capability}"`,
        'CAPABILITY_NOT_SUPPORTED',
        400,
        false,
      );
    }
    effectiveRequest.provider = selected.providerName;
  }
  if (ctx.tenantId || '') {
    const tenant = await prisma.tenant.findUnique({
      where: { id: ctx.tenantId || '' },
      select: {
        active: true,
        defaultTextProvider: true,
        defaultImageProvider: true,
        defaultModel: true,
        monthlyTokenLimit: true,
        monthlyRequestLimit: true,
      },
    });
    if (!tenant?.active) {
      throw new ProviderError('gateway', 'tenant inactive', 'TENANT_INACTIVE', 403);
    }
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    if (tenant.monthlyRequestLimit || tenant.monthlyTokenLimit) {
      const aggregate = await prisma.requestLog.aggregate({
        where: { tenantId: ctx.tenantId || '', createdAt: { gte: monthStart }, success: true },
        _count: { _all: true },
        _sum: { totalTokens: true },
      });
      if (tenant.monthlyRequestLimit && aggregate._count._all >= tenant.monthlyRequestLimit) {
        throw new ProviderError(
          'gateway',
          'monthly request limit reached',
          'MONTHLY_REQUEST_LIMIT',
          429,
        );
      }
      if (
        tenant.monthlyTokenLimit &&
        BigInt(aggregate._sum.totalTokens ?? 0) >= tenant.monthlyTokenLimit
      ) {
        throw new ProviderError(
          'gateway',
          'monthly token limit reached',
          'MONTHLY_TOKEN_LIMIT',
          429,
        );
      }
    }
    const tenantProvider =
      capability === 'image'
        ? tenant.defaultImageProvider
        : capability === 'chat'
          ? tenant.defaultTextProvider
          : undefined;
    effectiveRequest = {
      ...effectiveRequest,
      provider: effectiveRequest.provider ?? tenantProvider ?? undefined,
      model: effectiveRequest.model ?? tenant.defaultModel ?? undefined,
    };
  }

  // Roteamento automatico de modelo: so preenche quando o chamador (ou o
  // default do tenant, acima) nao forcou um `model` explicito.
  const memoryChoice =
    !effectiveRequest.provider && !effectiveRequest.model
      ? await recallExecutionRoute(capability, effectiveRequest, ctx.tenantId || '', ctx.projectId)
      : undefined;
  if (memoryChoice) {
    effectiveRequest = {
      ...effectiveRequest,
      provider: memoryChoice.provider,
      model: memoryChoice.model,
    };
  }
  if (!effectiveRequest.model) {
    let primaryProviderName: string | undefined;
    try {
      const primaryProvider = await registry.resolve(
        capability,
        effectiveRequest.provider as string | undefined,
      );
      primaryProviderName = primaryProvider.name;
    } catch {
      primaryProviderName = effectiveRequest.provider as string | undefined;
    }
    const routedModel = primaryProviderName
      ? pickModel(
          capability,
          effectiveRequest.task as TaskHint | undefined,
          primaryProviderName,
          process.env,
        )
      : undefined;
    if (routedModel) effectiveRequest = { ...effectiveRequest, model: routedModel };
  }

  const accountPool = registry.getAccountPool() ?? providerAccountPool;
  const targets = await resolveProviderAccountTargets(
    registry,
    accountPool,
    capability,
    effectiveRequest.provider,
    selectedAccountId,
  );
  const candidates: ProviderAccountTarget[] =
    effectiveRequest.fallback === false ? targets.slice(0, 1) : targets;
  if (!candidates.length) {
    throw new ProviderError(
      effectiveRequest.provider ?? 'registry',
      `no healthy provider account for ${capability}`,
      'NO_PROVIDER_AVAILABLE',
      503,
      false,
    );
  }

  delete effectiveRequest.providerAccountId;
  // Route handlers commonly close over the parsed request object (`body`).
  // Remove the routing-only field from that same object before invoking them.
  delete request.providerAccountId;
  Object.assign(request, effectiveRequest);

  for (const candidate of candidates) {
    try {
      // calculateScore agora Ã© async - usamos Promise para nÃ£o bloquear
      void registry.calculateScore(candidate.provider, capability).then((score) => {
        metrics.providerScore.set({ provider: candidate.provider.name, capability }, score);
      });
    } catch {
      /* ignore */
    }
  }
  const useCache = ctx.cache !== false && effectiveRequest.cache !== false;
  const {
    provider: _provider,
    cache: _cache,
    wait: _wait,
    fallback: _fallback,
    callback: _callback,
    execution: _execution,
    ...cacheInput
  } = effectiveRequest;
  let lastError: unknown;

  const readyCandidates = candidates.filter(
    (target) =>
      !providerCircuit.isOpen(
        `${target.provider.name}:${capability}${target.accountId ? `:${target.accountId}` : ''}`,
      ),
  );
  const forceProbe = readyCandidates.length === 0;

  for (const [candidateIndex, target] of candidates.entries()) {
    const provider = target.provider;
    request.model = candidateIndex === 0 ? effectiveRequest.model : clientModel;
    const requestedModel = request.model ?? 'provider-default';
    const modelKey = `${requestedModel}:${process.env.MODEL_CONFIG_VERSION ?? '1'}`;
    const hash = cacheService.generateKey({
      model: modelKey,
      tenant: ctx.tenantId || '',
      messages: (cacheInput as any).messages,
      prompt: (cacheInput as any).prompt,
      input: cacheInput,
      providerAccountId: target.accountId || selectedAccountId,
    });
    if (useCache) {
      const cacheResp = await cacheService.get(hash);
      const cached = cacheResp.data;
      if (cached) {
        metrics.requests.inc({
          capability,
          provider: (cached as any)?.provider,
          cached: 'true',
          status: 'ok',
        });
        usageService.record({
          tenantId: ctx.tenantId || '',
          apiKeyId: ctx.apiKeyId,
          capability,
          provider: (cached as any)?.provider,
          model: (cached as any).model,
          cached: true,
          success: true,
          durationMs: 0,
          tokens: (cached as any).tokens,
        });
        return enforceSynchronousQuality(
          ok({
            provider: (cached as any)?.provider,
            model: (cached as any).model,
            executionTime: 0,
            tokens: (cached as any).tokens,
            cached: true,
            result: (cached as any).result as T,
          }),
          capability,
          effectiveRequest,
        );
      }
    }

    const circuitKey = `${provider.name}:${capability}${target.accountId ? `:${target.accountId}` : ''}`;
    if ((forceProbe && candidateIndex > 0) || (!forceProbe && providerCircuit.isOpen(circuitKey))) {
      logger.debug(
        { capability, provider: provider.name },
        'provider skipped while circuit is open',
      );
      continue;
    }

    if (useCache) {
      const sharedCall = inFlight.get(hash) as Promise<ProviderResult<T>> | undefined;
      if (sharedCall) {
        try {
          const res = await sharedCall;
          metrics.requests.inc({
            capability,
            provider: provider.name,
            cached: 'true',
            status: 'ok',
          });
          usageService.record({
            tenantId: ctx.tenantId || '',
            apiKeyId: ctx.apiKeyId,
            capability,
            provider: provider.name,
            model: res.model,
            cached: true,
            success: true,
            durationMs: 0,
            tokens: res.tokens,
          });
          return enforceSynchronousQuality(
            ok({
              provider: provider.name,
              model: res.model,
              executionTime: 0,
              tokens: res.tokens,
              cached: true,
              result: res.result,
            }),
            capability,
            effectiveRequest,
          );
        } catch (err) {
          lastError = err;
          if (!canFailOver(err) || selectedAccountId) throw err;
          continue;
        }
      }
    }

    const start = Date.now();
    const providerInput = { ...effectiveRequest } as Record<string, unknown>;
    delete providerInput.providerAccountId;
    const providerCall = Promise.resolve().then(() => providerAttemptTracker.observe(
      attemptContext,
      { provider: provider.name, providerAccountId: target.accountId || undefined, capability, model: request.model },
      () => call(provider, providerInput),
    ));
    if (useCache) inFlight.set(hash, providerCall as Promise<ProviderResult<unknown>>);
    try {
      const res = await providerCall;
      const durationMs = Date.now() - start;
      providerCircuit.recordSuccess(circuitKey);
      const response = enforceSynchronousQuality(
        ok({
          provider: provider.name,
          model: res.model,
          executionTime: durationMs,
          tokens: res.tokens,
          cached: false,
          result: res.result,
        }),
        capability,
        effectiveRequest,
      );

      metrics.requests.inc({ capability, provider: provider.name, cached: 'false', status: 'ok' });
      metrics.duration.observe({ capability, provider: provider.name }, durationMs / 1000);
      if (res.tokens?.total) metrics.tokens.inc({ provider: provider.name }, res.tokens.total);
      usageService.record({
        tenantId: ctx.tenantId || '',
        apiKeyId: ctx.apiKeyId,
        capability,
        provider: provider.name,
        model: res.model,
        cached: false,
        success: true,
        durationMs,
        tokens: res.tokens,
      });
      Object.assign(response, {
        memory: { learned: true, routeReused: Boolean(memoryChoice), ...(memoryChoice ?? {}) },
      });
      void rememberExecutionSuccess(
        capability,
        effectiveRequest,
        { provider: provider.name, model: res.model },
        response.quality?.score ?? 100,
        durationMs,
        ctx.tenantId || '',
        ctx.projectId,
      );

      if (useCache) {
        const promptText =
          typeof request.prompt === 'string'
            ? request.prompt
            : JSON.stringify(request.messages ?? request.input ?? '').slice(0, 10_000);
        await cacheService.set(hash, response as any);
      }
      return response;
    } catch (err) {
      lastError = err;
      const circuit = providerCircuit.recordFailure(circuitKey);
      const durationMs = Date.now() - start;
      metrics.requests.inc({
        capability,
        provider: provider.name,
        cached: 'false',
        status: 'error',
      });
      usageService.record({
        tenantId: ctx.tenantId || '',
        apiKeyId: ctx.apiKeyId,
        capability,
        provider: provider.name,
        model: requestedModel,
        cached: false,
        success: false,
        errorCode: err instanceof Error ? err.name : 'UNKNOWN',
        durationMs,
      });
      logger.warn(
        {
          capability,
          provider: provider.name,
          accountId: target.accountId || undefined,
          errorCode: (err as any)?.code ?? (err instanceof Error ? err.name : 'UNKNOWN'),
          statusCode: (err as any)?.statusCode ?? (err as any)?.status,
          circuitOpenUntil: circuit.openUntil || undefined,
        },
        'provider failed',
      );
      if (!canFailOver(err) || selectedAccountId) throw err;
      if (candidates.length > candidateIndex + 1) {
        metrics.fallbacks.inc({
          capability,
          primary: candidates[0].provider.name,
          fallback: candidates[candidateIndex + 1].provider.name,
        });
      }
    } finally {
      if (useCache && inFlight.get(hash) === providerCall) inFlight.delete(hash);
    }
  }

  throw lastError ?? new Error(`No provider available for ${capability}`);
}
