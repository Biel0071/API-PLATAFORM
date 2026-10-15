import { createHash } from 'node:crypto';

export type KeyStatus = 'active' | 'cooldown' | 'exhausted' | 'disabled';

export interface KeyTokensUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface KeyMetrics {
  requests: number;
  tokens: KeyTokensUsage;
  errors: number;
  consecutiveRateLimits: number;
  latencyMs: number;
  lastUsedAt?: Date;
  cooldownUntil?: Date;
  cooldownReason?: string;
}

export interface KeyEntry {
  id: string;
  provider: string;
  rawKey: string;
  maskedKey: string;
  status: KeyStatus;
  models: string[];
  metrics: KeyMetrics;
  createdAt: Date;
  updatedAt: Date;
}

export interface SafeKeyReport {
  id: string;
  provider: string;
  maskedKey: string;
  status: KeyStatus;
  models: string[];
  requests: number;
  tokens: KeyTokensUsage;
  latencyMs: number;
  errors: number;
  lastUsedAt?: string;
  cooldownUntil?: string;
  cooldownReason?: string;
}

export class ProviderKeyManager {
  private static keys: Map<string, KeyEntry> = new Map();

  /**
   * Mascara qualquer chave de API para exibição segura em logs, dashboard e relatórios.
   * Exemplo: 'sk-1234567890abcdef1234567891ab' -> 'sk-****************91ab'
   * Nunca vaza o segredo.
   */
  public static maskKey(key: string): string {
    if (!key) return '';
    const trimmed = key.trim();
    if (trimmed.length <= 8) {
      return '****';
    }
    const prefixLen = trimmed.startsWith('sk-') ? 3 : Math.min(4, Math.floor(trimmed.length / 4));
    const suffixLen = Math.min(4, Math.floor(trimmed.length / 4));
    const prefix = trimmed.slice(0, prefixLen);
    const suffix = trimmed.slice(-suffixLen);
    return `${prefix}${'*'.repeat(Math.max(4, trimmed.length - prefixLen - suffixLen))}${suffix}`;
  }

  private static generateKeyId(provider: string, rawKey: string): string {
    const hash = createHash('sha256').update(`${provider}:${rawKey}`).digest('hex').slice(0, 12);
    return `key_${provider}_${hash}`;
  }

  /**
   * Registra uma chave para um provider. Se já existir, atualiza dados associados.
   */
  public static registerKey(
    provider: string,
    rawKey: string,
    models: string[] = [],
  ): KeyEntry {
    if (!rawKey || !rawKey.trim()) {
      throw new Error(`Cannot register empty key for provider "${provider}"`);
    }
    const id = this.generateKeyId(provider, rawKey.trim());
    const existing = this.keys.get(id);

    if (existing) {
      existing.models = Array.from(new Set([...existing.models, ...models]));
      existing.updatedAt = new Date();
      return existing;
    }

    const entry: KeyEntry = {
      id,
      provider: provider.toLowerCase(),
      rawKey: rawKey.trim(),
      maskedKey: this.maskKey(rawKey.trim()),
      status: 'active',
      models,
      metrics: {
        requests: 0,
        tokens: { prompt: 0, completion: 0, total: 0 },
        errors: 0,
        consecutiveRateLimits: 0,
        latencyMs: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.keys.set(id, entry);
    return entry;
  }

  /**
   * Obtém a melhor chave ativa para um provider.
   * Restaura chaves cujo tempo de cooldown já expirou.
   */
  public static getActiveKey(provider: string): KeyEntry | null {
    const p = provider.toLowerCase();
    const now = Date.now();

    const candidates = Array.from(this.keys.values()).filter((k) => k.provider === p);

    for (const key of candidates) {
      if (key.status === 'cooldown' && key.metrics.cooldownUntil && key.metrics.cooldownUntil.getTime() <= now) {
        // Cooldown expirou -> restaurar para ativo
        key.status = 'active';
        key.metrics.cooldownUntil = undefined;
        key.metrics.cooldownReason = undefined;
        key.updatedAt = new Date();
      }
    }

    const activeKeys = candidates.filter((k) => k.status === 'active');
    if (activeKeys.length === 0) return null;

    // Prioriza chaves com menor número de erros e mais tempo desde o último uso (round-robin / least-error)
    activeKeys.sort((a, b) => {
      if (a.metrics.errors !== b.metrics.errors) return a.metrics.errors - b.metrics.errors;
      const lastA = a.metrics.lastUsedAt?.getTime() || 0;
      const lastB = b.metrics.lastUsedAt?.getTime() || 0;
      return lastA - lastB;
    });

    return activeKeys[0];
  }

  /**
   * Registra sucesso em chamada usando a chave.
   */
  public static recordSuccess(
    keyId: string,
    latencyMs: number,
    tokens?: { prompt?: number; completion?: number; total?: number },
  ): void {
    const entry = this.keys.get(keyId);
    if (!entry) return;

    entry.metrics.requests += 1;
    entry.metrics.consecutiveRateLimits = 0; // reset
    entry.metrics.lastUsedAt = new Date();

    if (latencyMs > 0) {
      entry.metrics.latencyMs = entry.metrics.requests === 1
        ? latencyMs
        : Math.round(entry.metrics.latencyMs * 0.8 + latencyMs * 0.2);
    }

    if (tokens) {
      const p = tokens.prompt || 0;
      const c = tokens.completion || 0;
      const t = tokens.total || p + c;
      entry.metrics.tokens.prompt += p;
      entry.metrics.tokens.completion += c;
      entry.metrics.tokens.total += t;
    }

    entry.updatedAt = new Date();
  }

  /**
   * Registra erro em chamada usando a chave.
   * Se for HTTP 429 ou Rate Limit detectado, aplica cooldown com backoff exponencial.
   */
  public static recordError(
    keyId: string,
    statusCode?: number,
    errorMsg?: string,
  ): void {
    const entry = this.keys.get(keyId);
    if (!entry) return;

    entry.metrics.errors += 1;
    entry.metrics.lastUsedAt = new Date();

    const isRateLimit =
      statusCode === 429 ||
      (errorMsg && /rate[- ]limit|too many requests|quota|tpm|rpm/i.test(errorMsg));

    if (isRateLimit) {
      entry.metrics.consecutiveRateLimits += 1;
      // Backoff exponencial: 30s, 60s, 120s, 240s... max 15min
      const backoffSeconds = Math.min(900, 30 * Math.pow(2, entry.metrics.consecutiveRateLimits - 1));
      entry.status = 'cooldown';
      entry.metrics.cooldownUntil = new Date(Date.now() + backoffSeconds * 1000);
      entry.metrics.cooldownReason = `HTTP 429 / Rate Limit (cooldown de ${backoffSeconds}s)`;
    } else if (statusCode === 401 || statusCode === 403) {
      // Chave inválida ou não autorizada
      entry.status = 'exhausted';
      entry.metrics.cooldownReason = `Autenticação rejeitada (${statusCode}): chave inválida ou revogada`;
    }

    entry.updatedAt = new Date();
  }

  /**
   * Ativa ou desativa manualmente uma chave.
   */
  public static setKeyStatus(keyId: string, status: KeyStatus, reason?: string): void {
    const entry = this.keys.get(keyId);
    if (!entry) return;
    entry.status = status;
    if (reason) entry.metrics.cooldownReason = reason;
    entry.updatedAt = new Date();
  }

  /**
   * Retorna relatório seguro de todas as chaves (chaves sempre mascaradas).
   */
  public static listReport(provider?: string): SafeKeyReport[] {
    let list = Array.from(this.keys.values());
    if (provider) {
      list = list.filter((k) => k.provider === provider.toLowerCase());
    }

    return list.map((k) => ({
      id: k.id,
      provider: k.provider,
      maskedKey: k.maskedKey,
      status: k.status,
      models: k.models,
      requests: k.metrics.requests,
      tokens: { ...k.metrics.tokens },
      latencyMs: k.metrics.latencyMs,
      errors: k.metrics.errors,
      lastUsedAt: k.metrics.lastUsedAt?.toISOString(),
      cooldownUntil: k.metrics.cooldownUntil?.toISOString(),
      cooldownReason: k.metrics.cooldownReason,
    }));
  }

  /** Limpa o registro (usado em testes) */
  public static clear(): void {
    this.keys.clear();
  }
}
