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

export interface LayaConfig {
  onnxModelPath?: string;
  fastResponseThresholdMs?: number;
}

export class LayaProvider extends BaseProvider {
  readonly name = 'laya';
  readonly capabilities: Capability[] = ['decision'];
  private fastThresholdMs: number;

  constructor(config: LayaConfig = {}) {
    super();
    this.fastThresholdMs = config.fastResponseThresholdMs ?? 35;
  }

  /**
   * Executa a decisão semântica System 1 em menos de 35ms.
   */
  override async decision(input: DecisionInput): Promise<ProviderResult<DecisionResult>> {
    const start = performance.now();
    const text = this.extractText(input).trim();
    const lower = text.toLowerCase();

    // 1. Detecção de Projeto Complexo / Arquitetura / Multi-Agent
    const isComplex = this.detectComplexProject(lower);

    // 2. Detecção de Tarefa de Programação / Código
    const isCoding = this.detectCodingTask(lower, text);

    // 3. Detecção de Pergunta Rápida / Saudação / Conversa Direta
    const isFast = this.detectFastQuery(lower, text);

    let decisionType: 'fast' | 'coding' | 'reasoning' | 'workflow' | 'standard' = 'standard';
    let selectedModel = 'qwen2.5:3b';
    let selectedProvider = 'ollama';
    let needsBackground = false;
    let confidence = 0.90;
    let reason = 'General instruction query';
    let fastResponse: string | undefined;
    let strategy = 'single';

    if (isComplex) {
      decisionType = 'workflow';
      selectedModel = 'claude-3-5-sonnet-latest';
      selectedProvider = 'anthropic';
      needsBackground = true;
      confidence = 0.98;
      reason = 'Complex architecture / multi-step workflow detected';
      fastResponse = 'Identifiquei uma tarefa de alta complexidade arquitetural. Encaminhando para orquestração especializada.';
      strategy = 'ensemble_with_judge';
    } else if (isCoding) {
      decisionType = 'coding';
      selectedModel = 'deepseek-coder:6.7b';
      selectedProvider = 'ollama';
      needsBackground = false;
      confidence = 0.96;
      reason = 'Software engineering / coding task detected';
      fastResponse = 'Identifiquei uma tarefa de código/desenvolvimento. Ativando modelo especialista DeepSeek-Coder.';
      strategy = 'single_with_refinement';
    } else if (isFast) {
      decisionType = 'fast';
      selectedModel = 'qwen2.5:1.5b';
      selectedProvider = 'ollama';
      needsBackground = false;
      confidence = 0.99;
      reason = 'Low latency direct conversational request';
      strategy = 'single';
      if (this.isGreeting(lower)) {
        fastResponse = 'Olá! Como posso ajudar você hoje?';
      }
    }

    const elapsed = Math.round(performance.now() - start);

    const result: DecisionResult = {
      decision: decisionType,
      selectedModel,
      selectedProvider,
      fastResponse,
      needsBackground,
      confidence,
      latencyMs: elapsed,
      reason,
      strategy,
      metadata: {
        engine: 'LAYA-System1-Local',
        under35ms: elapsed <= this.fastThresholdMs,
        tokenEstimate: Math.ceil(text.length / 4),
      },
    };

    return {
      result,
      model: 'laya-system1',
      tokens: { prompt: Math.ceil(text.length / 4), completion: 15, total: Math.ceil(text.length / 4) + 15 },
    };
  }

  override async chat(input: ChatInput): Promise<ProviderResponse<{ message: ChatMessage }>> {
    const decisionRes = await this.decision({ messages: input.messages });
    const replyText = decisionRes.result.fastResponse ||
      `[LAYA System 1]: Decisão tomada em ${decisionRes.result.latencyMs}ms. Encaminhando para ${decisionRes.result.selectedModel} (${decisionRes.result.decision}).`;

    return {
      result: {
        message: {
          role: 'assistant',
          content: replyText,
        },
      },
      model: 'laya-system1',
      tokens: { prompt: 10, completion: 20, total: 30 },
    };
  }

  async models(): Promise<ModelInfo[]> {
    return [
      {
        id: 'laya-system1',
        name: 'LAYA System 1 Local Semantic Engine',
        capabilities: ['decision'],
        tier: 'cheap',
        latency: 15,
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

  private detectComplexProject(text: string): boolean {
    const patterns = [
      /\b(analise|audite|refatore|reformule)\s+(o\s+)?(meu\s+)?(projeto|sistema|repositório|arquitetura)\b/,
      /\b(multi[- ]agent|pipeline\s+completo|roadmap\s+completo|decomponha\s+a\s+tarefa)\b/,
      /\b(arquitetura|microserviços|fullstack|monorepo)\b/,
      /\b(planeje|crie\s+um\s+plano)\s+(de\s+)?(implementação|migração|arquitetura)\b/,
    ];
    return patterns.some((p) => p.test(text));
  }

  private detectCodingTask(lower: string, original: string): boolean {
    // 1. Markdown code block
    if (original.includes('```') || original.includes('function ') || original.includes('class ') || original.includes('import ')) {
      return true;
    }

    // 2. Linguagens de programação explícitas
    const languages = [
      /\b(typescript|javascript|python|rust|golang|c\+\+|cpp|c#|csharp|php|ruby|java|kotlin|swift|sql|html|css|bash|shell|powershell|dockerfile)\b/,
    ];
    if (languages.some((rgx) => rgx.test(lower))) {
      return true;
    }

    // 3. Ações e termos de engenharia de software
    const codingTerms = [
      /\b(código|codigo|code|programar|programação|programacao|script|função|funcao|endpoint|api|bug|fix|debug|refactor|refatorar)\b/,
      /\b(prisma|database|tabela|query|migration|vitest|jest|unit test|teste unitário|regex|algoritmo|algorithm)\b/,
      /\b(escreva\s+um|crie\s+um|desenvolva\s+um)\s+(código|script|programa|algoritmo|componente|service|controller)\b/,
    ];
    return codingTerms.some((rgx) => rgx.test(lower));
  }

  private detectFastQuery(lower: string, original: string): boolean {
    if (this.isGreeting(lower)) return true;
    if (original.length < 50 && !this.detectCodingTask(lower, original) && !this.detectComplexProject(lower)) {
      return true;
    }
    return false;
  }

  private isGreeting(lower: string): boolean {
    const cleaned = lower.replace(/[!?,.:;]/g, ' ').replace(/\s+/g, ' ').trim();
    const greetings = ['oi', 'olá', 'ola', 'hello', 'hi', 'hey', 'bom dia', 'boa tarde', 'boa noite', 'quem é você', 'o que você faz'];
    return greetings.some((g) => cleaned === g || cleaned.startsWith(g + ' ') || cleaned.includes(g));
  }
}
