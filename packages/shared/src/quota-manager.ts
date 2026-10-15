export interface ProviderQuotaLimit {
  maxRequestsPerMinute?: number;
  maxRequestsPerDay?: number;
  maxTokensPerMinute?: number;
  maxTokensPerDay?: number;
}

export interface ProviderQuotaUsage {
  requestsThisMinute: number;
  requestsToday: number;
  tokensThisMinute: number;
  tokensToday: number;
  lastMinuteReset: number;
  lastDayReset: number;
  totalRequests: number;
  totalTokens: number;
  error429Count: number;
}

export interface ProviderQuotaStatus {
  provider: string;
  isAvailable: boolean;
  reason?: string;
  usagePercentRpm: number;
  usagePercentRpd: number;
  usagePercentTpm: number;
  requestsThisMinute: number;
  requestsToday: number;
  tokensToday: number;
  limits: ProviderQuotaLimit;
}

/**
 * Limites padrão conhecidos dos tiers gratuitos (Free-Tier Provider Pool).
 * Podem ser atualizados via variáveis de ambiente ou configuração.
 */
export const DEFAULT_FREE_TIER_LIMITS: Record<string, ProviderQuotaLimit> = {
  groq: {
    maxRequestsPerMinute: 30,
    maxRequestsPerDay: 14400,
    maxTokensPerMinute: 6000,
    maxTokensPerDay: 500000,
  },
  openrouter: {
    maxRequestsPerMinute: 20,
    maxRequestsPerDay: 200,
    maxTokensPerMinute: 40000,
  },
  cloudflare: {
    maxRequestsPerMinute: 60,
    maxRequestsPerDay: 10000, // Franquia de neurônios aproximada
  },
  gemini: {
    maxRequestsPerMinute: 15,
    maxRequestsPerDay: 1500,
    maxTokensPerMinute: 1000000,
  },
  ollama: {
    // Local: sem limite de quota externa, limitado apenas pela concorrência da máquina
    maxRequestsPerMinute: 120,
    maxRequestsPerDay: 1000000,
  },
};

export class ProviderQuotaManager {
  private static usages: Map<string, ProviderQuotaUsage> = new Map();
  private static customLimits: Map<string, ProviderQuotaLimit> = new Map();

  private static getUsage(provider: string): ProviderQuotaUsage {
    const p = provider.toLowerCase();
    let usage = this.usages.get(p);
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    const todayStart = new Date().setHours(0, 0, 0, 0);

    if (!usage) {
      usage = {
        requestsThisMinute: 0,
        requestsToday: 0,
        tokensThisMinute: 0,
        tokensToday: 0,
        lastMinuteReset: now,
        lastDayReset: todayStart,
        totalRequests: 0,
        totalTokens: 0,
        error429Count: 0,
      };
      this.usages.set(p, usage);
      return usage;
    }

    // Reset de minuto
    if (usage.lastMinuteReset < oneMinuteAgo) {
      usage.requestsThisMinute = 0;
      usage.tokensThisMinute = 0;
      usage.lastMinuteReset = now;
    }

    // Reset de dia
    if (usage.lastDayReset < todayStart) {
      usage.requestsToday = 0;
      usage.tokensToday = 0;
      usage.lastDayReset = todayStart;
    }

    return usage;
  }

  /** Define ou sobrescreve limites de quota para um provider */
  public static setLimits(provider: string, limits: ProviderQuotaLimit): void {
    this.customLimits.set(provider.toLowerCase(), limits);
  }

  /** Retorna os limites configurados para um provider */
  public static getLimits(provider: string): ProviderQuotaLimit {
    const p = provider.toLowerCase();
    return this.customLimits.get(p) || DEFAULT_FREE_TIER_LIMITS[p] || {};
  }

  /**
   * Avalia a disponibilidade de quota para um provider antes de rotear uma requisição.
   * Não esgota um provedor se a utilização estiver próxima do teto (> 90%).
   */
  public static checkAvailability(
    provider: string,
    estimatedTokens: number = 200,
  ): { available: boolean; reason?: string; utilizationScore: number } {
    const p = provider.toLowerCase();
    const usage = this.getUsage(p);
    const limits = this.getLimits(p);

    let maxUtilization = 0;

    // RPM Check
    if (limits.maxRequestsPerMinute && limits.maxRequestsPerMinute > 0) {
      const utilRpm = usage.requestsThisMinute / limits.maxRequestsPerMinute;
      maxUtilization = Math.max(maxUtilization, utilRpm);
      if (usage.requestsThisMinute >= limits.maxRequestsPerMinute) {
        return {
          available: false,
          reason: `Limite de requisições por minuto atingido (${usage.requestsThisMinute}/${limits.maxRequestsPerMinute})`,
          utilizationScore: 1.0,
        };
      }
    }

    // RPD Check
    if (limits.maxRequestsPerDay && limits.maxRequestsPerDay > 0) {
      const utilRpd = usage.requestsToday / limits.maxRequestsPerDay;
      maxUtilization = Math.max(maxUtilization, utilRpd);
      if (usage.requestsToday >= limits.maxRequestsPerDay) {
        return {
          available: false,
          reason: `Limite de requisições diárias atingido (${usage.requestsToday}/${limits.maxRequestsPerDay})`,
          utilizationScore: 1.0,
        };
      }
    }

    // TPM Check
    if (limits.maxTokensPerMinute && limits.maxTokensPerMinute > 0) {
      const projectedTokens = usage.tokensThisMinute + estimatedTokens;
      const utilTpm = projectedTokens / limits.maxTokensPerMinute;
      maxUtilization = Math.max(maxUtilization, utilTpm);
      if (projectedTokens > limits.maxTokensPerMinute) {
        return {
          available: false,
          reason: `Limite de tokens por minuto atingido (${usage.tokensThisMinute}/${limits.maxTokensPerMinute})`,
          utilizationScore: 1.0,
        };
      }
    }

    // TPD Check
    if (limits.maxTokensPerDay && limits.maxTokensPerDay > 0) {
      const utilTpd = usage.tokensToday / limits.maxTokensPerDay;
      maxUtilization = Math.max(maxUtilization, utilTpd);
      if (usage.tokensToday + estimatedTokens > limits.maxTokensPerDay) {
        return {
          available: false,
          reason: `Limite diário de tokens atingido (${usage.tokensToday}/${limits.maxTokensPerDay})`,
          utilizationScore: 1.0,
        };
      }
    }

    return {
      available: true,
      utilizationScore: Math.min(1.0, maxUtilization),
    };
  }

  /** Registra consumo de requisição e tokens após execução */
  public static recordUsage(
    provider: string,
    tokens: { prompt?: number; completion?: number; total?: number },
  ): void {
    const usage = this.getUsage(provider);
    const p = tokens.prompt || 0;
    const c = tokens.completion || 0;
    const t = tokens.total || p + c;

    usage.requestsThisMinute += 1;
    usage.requestsToday += 1;
    usage.totalRequests += 1;

    usage.tokensThisMinute += t;
    usage.tokensToday += t;
    usage.totalTokens += t;
  }

  /** Registra ocorrência de 429 para cálculo de confiabilidade */
  public static record429(provider: string): void {
    const usage = this.getUsage(provider);
    usage.error429Count += 1;
  }

  /** Retorna relatório consolidado de status de quota por provider */
  public static getStatus(provider: string): ProviderQuotaStatus {
    const p = provider.toLowerCase();
    const usage = this.getUsage(p);
    const limits = this.getLimits(p);
    const check = this.checkAvailability(p);

    const rpmPercent = limits.maxRequestsPerMinute ? Math.round((usage.requestsThisMinute / limits.maxRequestsPerMinute) * 100) : 0;
    const rpdPercent = limits.maxRequestsPerDay ? Math.round((usage.requestsToday / limits.maxRequestsPerDay) * 100) : 0;
    const tpmPercent = limits.maxTokensPerMinute ? Math.round((usage.tokensThisMinute / limits.maxTokensPerMinute) * 100) : 0;

    return {
      provider: p,
      isAvailable: check.available,
      reason: check.reason,
      usagePercentRpm: rpmPercent,
      usagePercentRpd: rpdPercent,
      usagePercentTpm: tpmPercent,
      requestsThisMinute: usage.requestsThisMinute,
      requestsToday: usage.requestsToday,
      tokensToday: usage.tokensToday,
      limits,
    };
  }

  /** Limpa os registros de uso (para testes) */
  public static clear(): void {
    this.usages.clear();
    this.customLimits.clear();
  }
}
