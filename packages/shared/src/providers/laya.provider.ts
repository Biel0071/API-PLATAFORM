import {
  Capability,
  DecisionInput,
  DecisionResult,
  HealthStatus,
  ModelInfo,
  ProviderError,
  ProviderResult,
} from '../types';
import { BaseProvider } from './base.provider';

export interface LayaConfig {
  baseUrl?: string;
  timeoutMs?: number;
}

type LayaDecision = DecisionResult['decision'];

const routeModels: Record<LayaDecision, string> = {
  fast: 'gemma3:1b',
  coding: 'qwen2.5-coder:1.5b',
  reasoning: 'qwen3.5:0.8b',
  workflow: 'qwen3.5:0.8b',
  standard: 'llama3.2:1b',
};

const routeCriteria = {
  fast: 'Saudação ou pedido curto e direto que precisa de resposta simples.',
  coding: 'Programação, depuração, código ou tarefa de engenharia de software.',
  reasoning: 'Pergunta que exige análise ou raciocínio em várias etapas.',
  workflow: 'Projeto complexo, planejamento amplo ou fluxo de múltiplas etapas.',
  standard: 'Conversa ou pedido geral que não se enquadra nas outras opções.',
};

export class LayaProvider extends BaseProvider {
  readonly name = 'laya';
  readonly capabilities: Capability[] = ['decision'];
  private readonly baseUrl?: string;
  private readonly timeoutMs: number;

  constructor(config: LayaConfig = {}) {
    super();
    this.baseUrl = config.baseUrl?.trim().replace(/\/$/, '') || undefined;
    this.timeoutMs = config.timeoutMs ?? 2_000;
  }

  override async decision(input: DecisionInput): Promise<ProviderResult<DecisionResult>> {
    const state = this.extractText(input).trim();
    if (!state) throw new ProviderError(this.name, 'Decision text is empty', 'INVALID_INPUT', 400, false);
    const baseUrl = this.requireBaseUrl();
    const startedAt = performance.now();
    const response = await this.http<LayaResponse>(`${baseUrl}/v1/systemone`, {
      method: 'POST',
      timeoutMs: this.timeoutMs,
      body: {
        model: 'multilingual',
        state,
        questions: {
          route: {
            type: 'choice',
            instructions: 'Qual rota local deve processar esta solicitação?',
            criteria: routeCriteria,
          },
        },
      },
    });

    const route = response?.answers?.route?.choice;
    if (!isDecision(route)) {
      throw new ProviderError(this.name, 'Laya returned an unknown route label', 'LAYA_INVALID_RESPONSE', 502, false);
    }

    const confidence = response.answers?.route?.answer_confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new ProviderError(this.name, 'Laya response has no valid answer confidence', 'LAYA_INVALID_RESPONSE', 502, false);
    }

    const elapsed = Math.max(0, Math.round(performance.now() - startedAt));
    const inputTokens = response.usage?.input_tokens;
    const outputTokens = response.usage?.output_tokens;
    const tokens = typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? { prompt: inputTokens, completion: outputTokens, total: inputTokens + outputTokens }
      : undefined;

    return {
      result: {
        decision: route,
        selectedModel: routeModels[route],
        selectedProvider: 'ollama',
        needsBackground: route === 'workflow',
        confidence,
        latencyMs: elapsed,
        reason: `Laya classified the request as ${route}`,
        strategy: route === 'workflow' ? 'ensemble_with_judge' : 'single',
        metadata: { engine: 'laya-multilingual', source: 'model', upstreamModel: response.model },
      },
      model: 'laya-multilingual',
      ...(tokens ? { tokens } : {}),
    };
  }

  override async health(): Promise<HealthStatus> {
    if (!this.baseUrl) return { ok: false, message: 'LAYA_BASE_URL is not configured' };
    const startedAt = Date.now();
    try {
      const health = await this.http<{ status?: string }>(`${this.baseUrl}/health`, { timeoutMs: 2_000 });
      return health?.status === 'ok'
        ? { ok: true, latencyMs: Date.now() - startedAt, modelCount: 1 }
        : { ok: false, latencyMs: Date.now() - startedAt, message: 'Laya model is not ready' };
    } catch {
      return { ok: false, latencyMs: Date.now() - startedAt, message: 'Laya engine unavailable' };
    }
  }

  async models(): Promise<ModelInfo[]> {
    const health = await this.health();
    return health.ok
      ? [{ id: 'laya-multilingual', name: 'Laya multilingual decision model', capabilities: ['decision'], tier: 'cheap' }]
      : [];
  }

  private extractText(input: DecisionInput): string {
    if (input.prompt) return input.prompt;
    if (input.context) return input.context;
    return (input.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => typeof message.content === 'string' ? message.content : '')
      .join('\n');
  }

  private requireBaseUrl(): string {
    if (!this.baseUrl) {
      throw new ProviderError(this.name, 'LAYA_BASE_URL is not configured', 'LAYA_ENGINE_UNAVAILABLE', 503, false);
    }
    return this.baseUrl;
  }
}

interface LayaResponse {
  model?: string;
  answers?: { route?: { choice?: unknown; answer_confidence?: unknown } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

function isDecision(value: unknown): value is LayaDecision {
  return value === 'fast' || value === 'coding' || value === 'reasoning' || value === 'workflow' || value === 'standard';
}
