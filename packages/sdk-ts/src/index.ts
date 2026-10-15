/**
 * API Platform SDK (TypeScript)
 *
 * ```ts
 * import { apiplatform } from '@api-platform/sdk';
 * const ai = new apiplatform({ baseUrl: 'http://localhost:3000', apiKey: 'ap_...' });
 * const res = await ai.text({ prompt: 'Descreva um tenis de corrida' });
 * console.log(res.result.text);
 * ```
 */

export interface apiplatformOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface TokenUsage {
  prompt?: number;
  completion?: number;
  total?: number;
}

export interface StandardResponse<T = unknown> {
  success: boolean;
  provider: string;
  model: string;
  executionTime: number;
  tokens: TokenUsage | Record<string, never>;
  cached: boolean;
  result: T;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

export type RoutingPolicy =
  | 'ACCOUNT_FIRST'
  | 'API_FIRST'
  | 'COST_OPTIMIZED'
  | 'LOW_LATENCY'
  | 'LOCAL_FIRST'
  | 'AUTO';

export interface CommonParams {
  provider?: string;
  providerAccountId?: string;
  routingPolicy?: RoutingPolicy;
  model?: string;
  cache?: boolean;
}

export interface JobStatus {
  success: boolean;
  jobId: string;
  status: 'waiting' | 'active' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

export class apiplatformError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'apiplatformError';
  }
}

export class apiplatform {
  constructor(private readonly options: apiplatformOptions) {}

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 300_000);
    try {
      const res = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data: any = await res.json();
      if (!res.ok || data?.success === false) {
        throw new apiplatformError(
          data?.error?.code ?? 'HTTP_ERROR',
          data?.error?.message ?? `HTTP ${res.status}`,
          res.status,
        );
      }
      return data as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Geracao de texto (nomes, descricoes, SEO, anuncios...) */
  text(params: { prompt: string; system?: string; maxTokens?: number; temperature?: number; json?: boolean } & CommonParams) {
    return this.request<StandardResponse<{ text: string }>>('/v1/text', 'POST', params);
  }

  /** Conversa multi-turno */
  chat(params: { messages: ChatMessage[]; maxTokens?: number; temperature?: number } & CommonParams) {
    return this.request<StandardResponse<{ message: ChatMessage }>>('/v1/chat', 'POST', params);
  }

  /** Geracao de imagens (text2img / img2img) */
  image(
    params: {
      prompt: string;
      negativePrompt?: string;
      width?: number;
      height?: number;
      steps?: number;
      seed?: number;
      image?: string;
      wait?: boolean;
    } & CommonParams,
  ) {
    return this.request<StandardResponse<{ images: Array<{ base64?: string; url?: string }> }>>(
      '/v1/image',
      'POST',
      params,
    );
  }

  /** Upscale de imagem */
  upscale(params: { image: string; scale?: number; wait?: boolean } & CommonParams) {
    return this.request<StandardResponse<{ images: Array<{ base64?: string; url?: string }> }>>(
      '/v1/upscale',
      'POST',
      params,
    );
  }

  /** Analise de imagem (multimodal) */
  vision(params: { prompt: string; images: string[]; maxTokens?: number } & CommonParams) {
    return this.request<StandardResponse<{ text: string }>>('/v1/vision', 'POST', params);
  }

  /** Embeddings */
  embed(params: { input: string | string[] } & CommonParams) {
    return this.request<StandardResponse<{ embeddings: number[][] }>>('/v1/embed', 'POST', params);
  }

  /** OCR (vision ou tesseract, conforme configuracao do servidor) */
  ocr(params: { image: string; language?: string; wait?: boolean } & CommonParams) {
    return this.request<StandardResponse<{ text: string }>>('/v1/ocr', 'POST', params);
  }

  /** Enfileira um job assincrono (seo, translation, classification...) */
  createJob(params: { type: string; payload: Record<string, unknown>; priority?: number }) {
    return this.request<{ success: boolean; jobId: string; status: string }>('/v1/jobs', 'POST', params);
  }

  /** Consulta status/resultado de um job */
  getJob(jobId: string) {
    return this.request<JobStatus>(`/v1/jobs/${jobId}`, 'GET');
  }

  /** Aguarda um job terminar (polling) */
  async waitJob(jobId: string, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<JobStatus> {
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    while (Date.now() < deadline) {
      const status = await this.getJob(jobId);
      if (status.status === 'completed' || status.status === 'failed') return status;
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
    }
    throw new apiplatformError('TIMEOUT', `job ${jobId} did not finish in time`);
  }

  /** Lista modelos disponiveis */
  models(provider?: string) {
    const qs = provider ? `?provider=${encodeURIComponent(provider)}` : '';
    return this.request<{ success: boolean; providers: Array<{ provider: string; models: unknown[] }> }>(
      `/v1/models${qs}`,
      'GET',
    );
  }

  /** Lista providers e health de cada um */
  providers() {
    return this.request<{ success: boolean; providers: unknown[] }>('/v1/providers', 'GET');
  }

  /** Executa qualquer capability de forma dinamica */
  capability<T = unknown>(name: string, params: Record<string, unknown> & CommonParams) {
    return this.request<StandardResponse<T>>(`/v1/${name}`, 'POST', params);
  }

  /** Audio (STT / TTS) */
  audio(params: { type: 'stt' | 'tts'; data: string; language?: string } & CommonParams) {
    return this.request<StandardResponse<{ text?: string; audio?: string; language?: string; confidence?: number; metadata?: unknown }>>('/v1/audio', 'POST', params);
  }

  /** Missao (Agentes autonômos) */
  mission(params: { objective: string; context?: Record<string, unknown>; async?: boolean; maxSteps?: number } & CommonParams) {
    return this.request<StandardResponse<unknown> | JobStatus>('/v1/mission', 'POST', params);
  }

  /** Health da plataforma */
  health() {
    return this.request<{ success: boolean; status: string; providers: Record<string, any>; checks: Record<string, boolean>; uptime: number; timestamp: string }>('/v1/health', 'GET');
  }

  /** Lista contas de IA conectadas */
  listAccounts(providerName?: string) {
    const qs = providerName ? `?providerName=${encodeURIComponent(providerName)}` : '';
    return this.request<{ success: boolean; accounts: unknown[] }>(`/v1/accounts${qs}`, 'GET');
  }

  /** Consulta catálogo de provedores e modos de autenticação suportados */
  getProviderCatalog() {
    return this.request<{ success: boolean; providers: Record<string, unknown> }>('/v1/accounts/providers', 'GET');
  }

  /** Conecta uma conta de provedor (API Key, OAuth ou Servidor Local) */
  connectAccount(provider: string, params: {
    displayName?: string;
    authMode: 'apiKey' | 'oauth' | 'local';
    apiKey?: string;
    baseUrl?: string;
    settings?: Record<string, unknown>;
    enabled?: boolean;
  }) {
    return this.request<{ success: boolean; account?: unknown; authorizationUrl?: string; flowType?: string }>(
      `/v1/accounts/${encodeURIComponent(provider)}/connect`,
      'POST',
      params,
    );
  }

  /** Desconecta / revoga uma conta conectada */
  disconnectAccount(accountId: string) {
    return this.request<{ success: boolean; disconnected: boolean }>(`/v1/accounts/${encodeURIComponent(accountId)}/disconnect`, 'POST');
  }

  /** Renova credencial / token de uma conta */
  refreshAccount(accountId: string) {
    return this.request<{ success: boolean; refreshed: boolean }>(`/v1/accounts/${encodeURIComponent(accountId)}/refresh`, 'POST');
  }

  /** Executa teste real de integridade e latência na conta */
  testAccount(accountId: string) {
    return this.request<{ success: boolean; health: { ok: boolean; latencyMs: number | null; modelCount?: number | null } }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/test`,
      'POST',
    );
  }

  /** Consulta status da conta */
  getAccountStatus(accountId: string) {
    return this.request<{ success: boolean; status: unknown }>(`/v1/accounts/${encodeURIComponent(accountId)}/status`, 'GET');
  }

  /** Consulta consumo real de tokens e custos da conta (janelas 1h, 5h, 7d) */
  getAccountUsage(accountId: string) {
    return this.request<{ success: boolean; usage: unknown }>(`/v1/accounts/${encodeURIComponent(accountId)}/usage`, 'GET');
  }

  /** Consulta capacidades e modelos homologados para a conta */
  getAccountCapabilities(accountId: string) {
    return this.request<{ success: boolean; capabilities: unknown }>(`/v1/accounts/${encodeURIComponent(accountId)}/capabilities`, 'GET');
  }
}

/**
 * FenixIntelligenceClient
 * Cliente canônico do FÊNIX OS para consumir o Multi-Account AI Gateway da API Platform.
 */
export class FenixIntelligenceClient extends apiplatform {
  constructor(options: apiplatformOptions) {
    super(options);
  }

  /**
   * Executa uma inferência orquestrada pelo FÊNIX OS com roteamento inteligente
   */
  async orchestrate(params: {
    prompt: string;
    system?: string;
    routingPolicy?: RoutingPolicy;
    providerAccountId?: string;
    preferredProvider?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }) {
    return this.text({
      prompt: params.prompt,
      system: params.system,
      routingPolicy: params.routingPolicy ?? 'AUTO',
      providerAccountId: params.providerAccountId,
      provider: params.preferredProvider,
      model: params.model,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    });
  }
}

export default apiplatform;
