import {
  SmartModelRouter,
  RouteDecision,
  RouteCandidate,
  RoutingPolicy,
  ProviderKeyManager,
  ProviderQuotaManager,
  ModelCapability,
  ModelPool,
  ModelCapabilityRegistry,
  ProviderAttemptContext,
  createProviderAttemptContext,
} from '@api-platform/shared';
import { registry, providerCircuit } from './ai.service';
import { logger } from '../lib/logger';
import { ProviderAccountTarget, resolveProviderAccountTargets } from '@api-platform/shared';
import { providerAttemptTracker } from './provider-attempt.service';

function safeProviderError(error: any): string {
  const status = error?.statusCode ?? error?.status;
  const code = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,64}$/i.test(error.code) ? error.code : undefined;
  if (typeof status === 'number') return `Provider request failed (${status})${code ? `: ${code}` : ''}`;
  return code ? `Provider request failed: ${code}` : 'Provider request failed';
}

/**
 * Inicializa chaves do ambiente no ProviderKeyManager sem expor em logs.
 */
export function bootstrapKeyManagerFromEnv(env: Record<string, string | undefined> = process.env): void {
  const providerKeys: Array<[string, string | undefined]> = [
    ['groq', env.GROQ_API_KEY],
    ['openrouter', env.OPENROUTER_API_KEY],
    ['freellmapi', env.FREELLMAPI_API_KEY],
    ['huggingface', env.HUGGINGFACE_API_KEY],
    ['gemini', env.GEMINI_API_KEY],
    ['openai', env.OPENAI_API_KEY],
    ['anthropic', env.ANTHROPIC_API_KEY],
    ['cloudflare', env.CLOUDFLARE_API_TOKEN],
    ['xai', env.GROK_API_KEY],
  ];

  for (const [provider, key] of providerKeys) {
    if (key && key.trim()) {
      try {
        ProviderKeyManager.registerKey(provider, key.trim());
      } catch (e) {
        logger.warn(`Failed to register key for ${provider}: ${e}`);
      }
    }
  }
}

// Bootstrap inicial
bootstrapKeyManagerFromEnv();

export class SmartRouterService {
  private router: SmartModelRouter;

  constructor() {
    this.router = new SmartModelRouter(registry);
  }

  /**
   * Resolve a rota inteligente para um determinado payload.
   */
  public async route(
    input: any,
    options: { requestedModel?: string; preferredProvider?: string; routingPolicy?: RoutingPolicy } = {},
  ): Promise<RouteDecision> {
    const routingPolicy = options.routingPolicy || input.routingPolicy || input.routing_policy;
    if (input.providerAccountId) {
      const account = await (registry.getAccountPool())?.resolveAccount(input.providerAccountId);
      if (!account || !account.enabled) throw Object.assign(new Error('Provider account not found or disabled'), { status: 404, code: 'PROVIDER_ACCOUNT_NOT_FOUND' });
      if (input.provider && input.provider !== account.providerName) throw Object.assign(new Error('Provider account does not match provider'), { status: 400, code: 'PROVIDER_ACCOUNT_MISMATCH' });
      const decision = await this.router.resolveRoute(input, { ...options, preferredProvider: account.providerName, routingPolicy });
      const primary = { ...decision.primary, provider: account.providerName, providerAccountId: account.accountId };
      return { ...decision, primary, fallbackChain: [] };
    }
    return this.router.resolveRoute(input, { ...options, routingPolicy });
  }

  /**
   * Executa a inferência tentando a rota primária e fazendo fallback estrito
   * apenas para provedores/modelos compatíveis com as capacidades necessárias.
   */
  public async executeWithSmartFallback(
    input: any,
    decision: RouteDecision,
    options: {
      tenantId?: string;
      projectId?: string;
      attemptContext?: ProviderAttemptContext;
      onCandidateAttempt?: (candidate: RouteCandidate, attemptNumber: number) => void;
    } = {},
  ): Promise<{
    result: any;
    selectedCandidate: RouteCandidate;
    attempts: Array<{ candidate: RouteCandidate; durationMs: number; error?: string }>;
  }> {
    const attemptContext = options.attemptContext ?? createProviderAttemptContext();
    const candidates = [decision.primary, ...decision.fallbackChain];
    const attempts: Array<{ candidate: RouteCandidate; durationMs: number; error?: string }> = [];

    let lastError: any = null;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const start = Date.now();

      // Checa se há quota disponível
      const quotaCheck = ProviderQuotaManager.checkAvailability(candidate.provider);
      if (!quotaCheck.available) {
        attempts.push({
          candidate,
          durationMs: 0,
          error: `Quota exhausted: ${quotaCheck.reason}`,
        });
        continue;
      }

      // Expand each catalog provider into healthy account instances first.
      const capability = decision.requiredCapabilities.includes('vision') ? 'vision' : 'chat';
      let targets: ProviderAccountTarget[];
      try {
        const pool = registry.getAccountPool();
        targets = pool
          ? await resolveProviderAccountTargets(registry, pool, capability, candidate.provider, candidate.providerAccountId)
          : [{ accountId: '', providerName: candidate.provider, provider: registry.get(candidate.provider) }];
      } catch (error) {
        lastError = error;
        if (candidate.providerAccountId) throw error;
        continue;
      }
      if (!targets.length) continue;

      for (const target of targets) {
      const effectiveCandidate = target.accountId ? { ...candidate, providerAccountId: target.accountId } : candidate;
      const circuitKey = `${candidate.provider}:${capability}${target.accountId ? `:${target.accountId}` : ''}`;
      if (providerCircuit.isOpen(circuitKey)) {
        attempts.push({ candidate: effectiveCandidate, durationMs: 0, error: 'Circuit breaker open' });
        continue;
      }
      const provider = target.provider;
      if (!provider) {
        attempts.push({
          candidate,
          durationMs: 0,
          error: `Provider ${candidate.provider} not registered in runtime`,
        });
        continue;
      }

      if (options.onCandidateAttempt) {
        options.onCandidateAttempt(effectiveCandidate, i + 1);
      }

      const activeKey = candidate.provider === 'ollama' ? null : ProviderKeyManager.getActiveKey(candidate.provider);

      try {
        const { providerAccountId: _providerAccountId, ...safeInput } = input;
        const payloadWithModel = {
          ...safeInput,
          model: candidate.model !== 'auto' ? candidate.model : undefined,
        };

        let response: any;
        const isVision = decision.requiredCapabilities.includes('vision');

        if (isVision) {
          response = await providerAttemptTracker.observe(attemptContext, { provider: provider.name, providerAccountId: target.accountId || undefined, capability, model: payloadWithModel.model }, () => provider.vision(payloadWithModel));
        } else {
          response = await providerAttemptTracker.observe(attemptContext, { provider: provider.name, providerAccountId: target.accountId || undefined, capability, model: payloadWithModel.model }, () => provider.chat(payloadWithModel));
        }

        const durationMs = Date.now() - start;

        // Registra sucesso no circuit breaker, key manager e quota manager
        providerCircuit.recordSuccess(circuitKey);
        if (activeKey) {
          ProviderKeyManager.recordSuccess(activeKey.id, durationMs, response.tokens);
        }
        ProviderQuotaManager.recordUsage(candidate.provider, response.tokens || { prompt: 0, completion: 0, total: 0 });

        attempts.push({ candidate: effectiveCandidate, durationMs });

        return {
          result: response,
          selectedCandidate: effectiveCandidate,
          attempts,
        };
      } catch (err: any) {
        const durationMs = Date.now() - start;
        const statusCode = err?.status || err?.statusCode;
        const errorMsg = safeProviderError(err);

        // Registra falha no circuit breaker apenas se não for 404 (modelo específico não instalado)
        const isModelNotFound = statusCode === 404 || /not found|não encontrado/i.test(errorMsg);
        if (!isModelNotFound) {
          providerCircuit.recordFailure(circuitKey);
        }

        // Se for erro de quota ou rate limit
        if (statusCode === 429 || /rate[- ]limit|too many requests/i.test(errorMsg)) {
          ProviderQuotaManager.record429(candidate.provider);
        }

        if (activeKey) {
          ProviderKeyManager.recordError(activeKey.id, statusCode, errorMsg);
        }

        attempts.push({ candidate: effectiveCandidate, durationMs, error: errorMsg });
        lastError = err;
        const retryable = statusCode === 408 || statusCode === 425 || statusCode === 429 || (typeof statusCode === 'number' && statusCode >= 500) || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err?.code ?? '');
        if (!retryable || candidate.providerAccountId) throw err;
      }
      }
    }

    throw lastError || new Error('All compatible providers in the smart fallback cascade failed.');
  }
}

export const smartRouterService = new SmartRouterService();
