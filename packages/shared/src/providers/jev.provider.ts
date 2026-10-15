import {
  Capability,
  ChatInput,
  ChatMessage,
  DecisionInput,
  DecisionResult,
  ModelInfo,
  ProviderResponse,
  ProviderResult,
} from '../types';
import { BaseProvider } from './base.provider';

export interface JevConfig {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class JevProvider extends BaseProvider {
  readonly name = 'jev';
  readonly capabilities: Capability[] = ['decision'];
  private baseUrl?: string;
  private apiKey?: string;

  constructor(config: JevConfig = {}) {
    super();
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    if (config.timeoutMs) {
      this.defaultTimeoutMs = config.timeoutMs;
    }
  }

  /**
   * Executa a decisão semântica System 1 Cloud (com fallback heurístico local quando offline).
   */
  override async decision(input: DecisionInput): Promise<ProviderResult<DecisionResult>> {
    const start = performance.now();

    // Se houver endpoint upstream configurado, tenta fazer a requisição HTTP
    if (this.baseUrl && this.apiKey) {
      try {
        const upstream = await this.http<{ decision: DecisionResult }>(`${this.baseUrl}/decide`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
          },
          body: input,
          timeoutMs: 3000,
        });
        if (upstream?.decision) {
          const elapsed = Math.round(performance.now() - start);
          return {
            result: { ...upstream.decision, latencyMs: elapsed },
            model: 'jev-cloud',
            tokens: { prompt: 10, completion: 20, total: 30 },
          };
        }
      } catch {
        // Fallback para heurística se a nuvem falhar
      }
    }

    const text = this.extractText(input).trim();
    const lower = text.toLowerCase();

    const isCoding = /\b(código|codigo|code|programação|programacao|script|função|funcao|endpoint|api|bug|fix|typescript|python|rust|sql|react)\b/i.test(lower);
    const isComplex = /\b(arquitetura|projeto|sistema|multi[- ]agent|pipeline|roadmap|audite|analise)\b/i.test(lower);

    let decisionType: 'fast' | 'coding' | 'reasoning' | 'workflow' | 'standard' = 'standard';
    let selectedModel = 'qwen2.5:3b';
    let selectedProvider = 'ollama';
    let needsBackground = false;
    let confidence = 0.95;
    let reason = 'JEV Cloud Decision';

    if (isComplex) {
      decisionType = 'workflow';
      selectedModel = 'claude-3-5-sonnet-latest';
      selectedProvider = 'anthropic';
      needsBackground = true;
      reason = 'JEV Cloud: Complex architecture workflow';
    } else if (isCoding) {
      decisionType = 'coding';
      selectedModel = 'deepseek-coder:6.7b';
      selectedProvider = 'ollama';
      reason = 'JEV Cloud: Coding / Software Development';
    } else {
      decisionType = 'fast';
      selectedModel = 'qwen2.5:1.5b';
      selectedProvider = 'ollama';
      reason = 'JEV Cloud: Fast response query';
    }

    const elapsed = Math.round(performance.now() - start);

    return {
      result: {
        decision: decisionType,
        selectedModel,
        selectedProvider,
        fastResponse: `[JEV Cloud]: Tarefa classificada como ${decisionType}.`,
        needsBackground,
        confidence,
        latencyMs: elapsed,
        reason,
        strategy: isComplex ? 'ensemble_with_judge' : isCoding ? 'single_with_refinement' : 'single',
        metadata: { engine: 'JEV-Cloud-Decision' },
      },
      model: 'jev-cloud',
      tokens: { prompt: Math.ceil(text.length / 4), completion: 15, total: Math.ceil(text.length / 4) + 15 },
    };
  }

  override async chat(input: ChatInput): Promise<ProviderResponse<{ message: ChatMessage }>> {
    const decisionRes = await this.decision({ messages: input.messages });
    return {
      result: {
        message: {
          role: 'assistant',
          content: decisionRes.result.fastResponse || `[JEV Cloud]: Encaminhado para ${decisionRes.result.selectedModel}`,
        },
      },
      model: 'jev-cloud',
      tokens: { prompt: 10, completion: 20, total: 30 },
    };
  }

  async models(): Promise<ModelInfo[]> {
    return [
      {
        id: 'jev-cloud',
        name: 'JEV System 1 Cloud Fast Decision Model',
        capabilities: ['decision'],
        tier: 'cheap',
        latency: 45,
      },
    ];
  }

  private extractText(input: DecisionInput): string {
    if (input.prompt) return input.prompt;
    if (Array.isArray(input.messages) && input.messages.length > 0) {
      return input.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');
    }
    return '';
  }
}
