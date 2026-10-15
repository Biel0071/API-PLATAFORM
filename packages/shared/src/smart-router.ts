import {
  ModelCapability,
  ModelCapabilityInfo,
  ModelCapabilityRegistry,
  ModelPool,
} from './capabilities';
import { ProviderKeyManager } from './key-manager';
import { ProviderQuotaManager } from './quota-manager';
import { ProviderRegistry } from './providers/registry';
import { Capability, ChatInput, ProviderError, ProviderResponse } from './types';

export type RoutingPolicy =
  | 'ACCOUNT_FIRST'
  | 'API_FIRST'
  | 'COST_OPTIMIZED'
  | 'LOW_LATENCY'
  | 'LOCAL_FIRST'
  | 'AUTO';

export interface RouteCandidate {
  provider: string;
  providerAccountId?: string;
  model: string;
  modelInfo?: ModelCapabilityInfo;
  score: number;
  latencyMs: number;
  reason: string;
  capabilities: ModelCapability[];
  pool: ModelPool;
  authMode?: 'apiKey' | 'oauth' | 'local';
  isAccount?: boolean;
}

export interface RouteDecision {
  primary: RouteCandidate;
  fallbackChain: RouteCandidate[];
  pool: ModelPool;
  requiredCapabilities: ModelCapability[];
  taskType: string;
  complexityScore: number;
  routingPolicy: RoutingPolicy;
}

export class SmartModelRouter {
  constructor(private readonly registry?: ProviderRegistry) {}

  /**
   * Infere as capacidades essenciais exigidas a partir das mensagens e payload.
   * Ex: Imagens exigem 'vision'. Code blocks exigem 'coding'.
   */
  public static inferRequiredCapabilities(input: any): ModelCapability[] {
    const caps = new Set<ModelCapability>(['chat']);

    if (Array.isArray(input.requiredCapabilities)) {
      for (const cap of input.requiredCapabilities) {
        caps.add(cap);
      }
    }

    const messages = Array.isArray(input.messages) ? input.messages : [];
    const hasImages =
      (Array.isArray(input.images) && input.images.length > 0) ||
      messages.some((m: any) => Array.isArray(m.images) && m.images.length > 0) ||
      input.capability === 'vision' ||
      input.task === 'vision';

    if (hasImages) {
      caps.add('vision');
    }

    if (input.tools && Array.isArray(input.tools) && input.tools.length > 0) {
      caps.add('tool_use');
    }

    if (input.json === true || input.format === 'json' || input.response_format?.type === 'json_object') {
      caps.add('json');
    }

    const text = [
      input.prompt || '',
      ...messages.map((m: any) => (typeof m.content === 'string' ? m.content : '')),
    ].join(' ').toLowerCase();

    // Detecção de Código
    const codingPatterns = [
      /```[\w]*\n/,
      /\b(function|class|def|const|let|var|return|import|export|sql|select|insert|update|delete|bug|refactor|typescript|javascript|python)\b/,
      /\b(git|npm|docker|kubernetes|api|endpoint|controller|service|component)\b/,
    ];
    if (codingPatterns.some((pattern) => pattern.test(text))) {
      caps.add('coding');
    }

    // Detecção de Raciocínio Profundo / Arquitetura
    const reasoningPatterns = [
      /\b(por que|explique o motivo|demonstre|resolva o problema|analise a arquitetura|trade-off|passo a passo|planejamento|proof|raciocínio|reasoning)\b/,
      /\b(matemática|cálculo|probabilidade|otimização|algoritmo)\b/,
    ];
    if (reasoningPatterns.some((pattern) => pattern.test(text))) {
      caps.add('reasoning');
    }

    // Classificação explícita via task
    if (input.task === 'classification' || input.task === 'quality') {
      caps.add('classification');
    }

    return Array.from(caps);
  }

  /**
   * Estima o score de complexidade de 0 a 100 da requisição.
   */
  public static estimateComplexity(input: any, requiredCaps: ModelCapability[]): { score: number; taskType: string } {
    let score = 20; // baseline para chat comum
    let taskType = 'chat';

    const messages = Array.isArray(input.messages) ? input.messages : [];
    const totalChars = messages.reduce((acc: number, m: any) => acc + (m.content?.length || 0), 0) + (input.prompt?.length || 0);

    if (totalChars > 4000) score += 25;
    else if (totalChars > 1500) score += 15;

    if (requiredCaps.includes('vision')) {
      score += 25;
      taskType = 'vision';
    }
    if (requiredCaps.includes('coding')) {
      score += 20;
      taskType = 'coding';
    }
    if (requiredCaps.includes('reasoning')) {
      score += 30;
      taskType = 'reasoning';
    }
    if (requiredCaps.includes('tool_use')) {
      score += 20;
      taskType = 'agentic';
    }

    // Tarefas com instruções de missão ou alta complexidade
    const text = (input.prompt || '') + ' ' + messages.map((m: any) => m.content || '').join(' ');
    if (/\b(missão|orquestr|arquitetura do projeto|pipeline completo|multi-agent)\b/i.test(text)) {
      score = Math.max(score, 85);
      taskType = 'mission';
    }

    return { score: Math.min(100, score), taskType };
  }

  /**
   * Seleciona o pool lógico ideal com base no input ou alias solicitado.
   */
  public static resolveTargetPool(input: any, requestedModel?: string): ModelPool {
    const aliasPool = ModelCapabilityRegistry.resolvePoolFromAlias(requestedModel || input.pool || input.tier);
    if (aliasPool !== 'AUTO') {
      return aliasPool;
    }

    const caps = this.inferRequiredCapabilities(input);
    const { score, taskType } = this.estimateComplexity(input, caps);

    if (caps.includes('vision')) return 'VISION';
    if (score >= 80) return 'POWER';
    if (caps.includes('reasoning') && score >= 60) return 'REASONING';
    if (caps.includes('coding')) return 'CODING';
    if (score <= 35) return 'FAST';

    return 'GENERAL';
  }

  /**
   * Calcula o score operacional numérico de um candidato (0..100).
   * Considera: compatibilidade de capacidades, saúde, latência, quota, confiabilidade e prioridade local.
   */
  public static calculateScore(params: {
    modelInfo: ModelCapabilityInfo;
    requiredCaps: ModelCapability[];
    isHealthy: boolean;
    hasActiveKey: boolean;
    quotaAvailable: boolean;
    quotaUtilization: number;
    latencyMs: number;
    isLocal: boolean;
    policy?: RoutingPolicy;
    isAccount?: boolean;
    authMode?: 'apiKey' | 'oauth' | 'local';
  }): number {
    const {
      modelInfo,
      requiredCaps,
      isHealthy,
      hasActiveKey,
      quotaAvailable,
      quotaUtilization,
      latencyMs,
      isLocal,
      policy = 'AUTO',
      isAccount = false,
      authMode,
    } = params;

    // 1. Compatibilidade estrita: se faltar capacidade mandatória, score é 0 (rejeição total)
    const hasAllCaps = requiredCaps.every((c) => modelInfo.capabilities.includes(c));
    if (!hasAllCaps) return 0;

    // Se o provedor não estiver saudável ou sem chave ativa para externos e sem conta, score mínimo
    if (!isHealthy) return 5;
    if (!isLocal && !hasActiveKey && !isAccount) return 10;

    // 2. Quota (0 a 25 pts)
    let quotaScore = 25;
    if (!quotaAvailable) {
      quotaScore = 0;
    } else {
      quotaScore = Math.max(0, Math.round(25 * (1 - quotaUtilization)));
    }

    // 3. Latência (0 a 25 pts)
    let latencyScore = 20;
    if (latencyMs > 0) {
      if (latencyMs < 300) latencyScore = 25;
      else if (latencyMs < 800) latencyScore = 20;
      else if (latencyMs < 2000) latencyScore = 15;
      else if (latencyMs < 5000) latencyScore = 10;
      else latencyScore = 5;
    } else {
      // Sem medição histórica: estimativa por tier
      latencyScore = modelInfo.latencyTier === 'instant' ? 25 : modelInfo.latencyTier === 'low' ? 20 : 15;
    }

    // 4. Confiabilidade e Saúde (0 a 25 pts)
    const healthScore = modelInfo.status === 'available' ? 25 : modelInfo.status === 'configured' ? 20 : 10;

    // 5. Prioridade Operacional e Política de Roteamento (0 a 50 pts)
    let policyScore = 15;
    switch (policy) {
      case 'LOCAL_FIRST':
        if (isLocal || authMode === 'local') {
          policyScore = 50;
        } else if (modelInfo.pricingTier === 'free') {
          policyScore = 20;
        } else {
          policyScore = 10;
        }
        break;

      case 'ACCOUNT_FIRST':
        if (isAccount) {
          policyScore = authMode === 'oauth' ? 50 : 45;
        } else {
          policyScore = 15;
        }
        break;

      case 'API_FIRST':
        if (!isAccount || authMode === 'apiKey') {
          policyScore = 45;
        } else {
          policyScore = 15;
        }
        break;

      case 'COST_OPTIMIZED':
        if (isLocal || authMode === 'local') {
          policyScore = 50;
        } else if (modelInfo.pricingTier === 'free') {
          policyScore = 45;
        } else if (modelInfo.pricingTier === 'low') {
          policyScore = 30;
        } else {
          policyScore = 10;
        }
        break;

      case 'LOW_LATENCY':
        if (latencyMs > 0 && latencyMs < 300) {
          policyScore = 50;
        } else if (modelInfo.latencyTier === 'instant') {
          policyScore = 48;
        } else if (latencyMs > 0 && latencyMs < 800) {
          policyScore = 35;
        } else if (modelInfo.latencyTier === 'low') {
          policyScore = 32;
        } else if (latencyMs > 0 && latencyMs < 2000) {
          policyScore = 20;
        } else {
          policyScore = 10;
        }
        break;

      case 'AUTO':
      default:
        if (isLocal) {
          policyScore = 25; // Local first
        } else if (modelInfo.pricingTier === 'free') {
          policyScore = 20; // Free-tier cloud second
        } else if (modelInfo.pricingTier === 'low') {
          policyScore = 15;
        } else {
          policyScore = 10;
        }
        break;
    }

    return quotaScore + latencyScore + healthScore + policyScore;
  }

  /**
   * Resolve a melhor rota (Primary + Fallback Chain) para uma dada requisição.
   */
  public async resolveRoute(
    input: any,
    options: {
      requestedModel?: string;
      preferredProvider?: string;
      routingPolicy?: RoutingPolicy;
    } = {},
  ): Promise<RouteDecision> {
    const rawModel = options.requestedModel || input.model;
    const policy: RoutingPolicy =
      options.routingPolicy || input.routingPolicy || input.routing_policy || 'AUTO';
    const requiredCaps = SmartModelRouter.inferRequiredCapabilities(input);
    const { score: complexityScore, taskType } = SmartModelRouter.estimateComplexity(input, requiredCaps);
    const pool = SmartModelRouter.resolveTargetPool(input, rawModel);

    // Se o cliente solicitou um modelo específico real (não alias de pool)
    const specificModel = rawModel && !['auto', 'fast', 'quick', 'coding', 'reasoning', 'vision', 'power', 'general'].includes(rawModel.toLowerCase())
      ? ModelCapabilityRegistry.getModel(rawModel)
      : undefined;

    // Obter modelos compatíveis do pool ou de todo o catálogo
    let candidateModels = ModelCapabilityRegistry.filterByCapabilities(requiredCaps, pool);

    if (candidateModels.length === 0) {
      // Relaxa o pool para achar qualquer modelo compatível com as capacidades requeridas
      candidateModels = ModelCapabilityRegistry.filterByCapabilities(requiredCaps);
    }

    if (candidateModels.length === 0) {
      throw new ProviderError(
        'smart-router',
        `No model found satisfying required capabilities: [${requiredCaps.join(', ')}]`,
        'NO_CAPABLE_MODEL_FOUND',
        503,
      );
    }

    const accountPool = this.registry?.getAccountPool();
    const accounts = accountPool ? await accountPool.listAccounts() : [];

    const scoredCandidates: RouteCandidate[] = [];

    for (const m of candidateModels) {
      const isLocal = m.provider === 'ollama';
      let isHealthy = true;

      if (this.registry && this.registry.has(m.provider)) {
        try {
          const p = this.registry.get(m.provider);
          const h = await p.health();
          isHealthy = h.ok;
        } catch {
          isHealthy = false;
        }
      }

      const activeKey = isLocal ? true : Boolean(ProviderKeyManager.getActiveKey(m.provider) || process.env[`${m.provider.toUpperCase()}_API_KEY`]);
      const quotaCheck = ProviderQuotaManager.checkAvailability(m.provider);
      const keyEntry = isLocal ? null : ProviderKeyManager.getActiveKey(m.provider);
      const latencyMs = keyEntry?.metrics?.latencyMs || 0;

      // Localizar contas ativas/configuradas para o provedor no pool de contas
      const providerAccounts = accounts.filter(
        (a) => a.providerName === m.provider && a.enabled,
      );

      if (providerAccounts.length > 0) {
        for (const acc of providerAccounts) {
          const accHealthy = acc.healthOk !== false && isHealthy;
          const accLatencyMs = acc.healthLatencyMs ?? latencyMs;
          const accScore = SmartModelRouter.calculateScore({
            modelInfo: m,
            requiredCaps,
            isHealthy: accHealthy,
            hasActiveKey: true,
            quotaAvailable: quotaCheck.available,
            quotaUtilization: quotaCheck.utilizationScore,
            latencyMs: accLatencyMs,
            isLocal,
            policy,
            isAccount: true,
            authMode: acc.authMode,
          });

          let finalScore = specificModel && specificModel.id === m.id ? accScore + 30 : accScore;
          if (options.preferredProvider === m.provider) finalScore += 25;

          scoredCandidates.push({
            provider: m.provider,
            providerAccountId: acc.accountId,
            model: m.id,
            modelInfo: m,
            score: finalScore,
            latencyMs: accLatencyMs,
            reason: `${policy}: Account (${acc.authMode || 'connected'})`,
            capabilities: m.capabilities,
            pool,
            authMode: acc.authMode,
            isAccount: true,
          });
        }
      }

      // Candidato direto via API Key / ambiente / local
      if (activeKey || providerAccounts.length === 0) {
        const score = SmartModelRouter.calculateScore({
          modelInfo: m,
          requiredCaps,
          isHealthy,
          hasActiveKey: activeKey,
          quotaAvailable: quotaCheck.available,
          quotaUtilization: quotaCheck.utilizationScore,
          latencyMs,
          isLocal,
          policy,
          isAccount: false,
          authMode: isLocal ? 'local' : 'apiKey',
        });

        let finalScore = specificModel && specificModel.id === m.id ? score + 30 : score;
        if (options.preferredProvider === m.provider) finalScore += 25;

        scoredCandidates.push({
          provider: m.provider,
          model: m.id,
          modelInfo: m,
          score: finalScore,
          latencyMs,
          reason: isLocal ? 'Local First' : quotaCheck.available ? 'Direct API / Cloud' : 'Quota Limited',
          capabilities: m.capabilities,
          pool,
          authMode: isLocal ? 'local' : 'apiKey',
          isAccount: false,
        });
      }
    }

    // Ordena pelo maior score operacional
    scoredCandidates.sort((a, b) => b.score - a.score);

    const primary = scoredCandidates[0];
    const fallbackChain = scoredCandidates.slice(1);

    return {
      primary,
      fallbackChain,
      pool,
      requiredCapabilities: requiredCaps,
      taskType,
      complexityScore,
      routingPolicy: policy,
    };
  }
}
