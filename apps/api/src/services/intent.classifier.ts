import { ExecutionMode, IntentResult, estimatePayloadTokens } from '@api-platform/shared';

export class FastIntentClassifier {
  /**
   * Classifica a requisição baseada em heurísticas rápidas e semânticas System 1.
   * Não utiliza chamada de rede pesada, resultando em latência < 1ms.
   */
  static classify(messages: any[], options: { tools?: any[]; prompt?: string } = {}): IntentResult {
    const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
    
    let hasImages = false;
    let hasFiles = false;
    
    let allText = options.prompt || '';

    // Verifica conteúdo multimídia e extrai texto das mensagens
    for (const msg of messages || []) {
      if (typeof msg?.content === 'string') {
        allText += '\n' + msg.content;
      } else if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
          if (part.type === 'image_url' || part.type === 'image') hasImages = true;
          if (part.type === 'file' || part.type === 'document') hasFiles = true;
          if (part.type === 'text' && typeof part.text === 'string') {
            allText += '\n' + part.text;
          }
        }
      }
    }

    const lower = allText.toLowerCase();

    // 1. Detecção de Projeto Complexo / Arquitetura / Multi-Agent
    const isComplexProject = this.detectComplexProject(lower);

    // 2. Detecção de Código / Programação
    const isCoding = this.detectCoding(lower, allText);

    if (hasFiles || hasImages || hasTools || isComplexProject) {
      return {
        mode: ExecutionMode.WORKFLOW,
        confidence: 0.99,
        isCoding,
        isComplexProject,
        recommendedPool: isComplexProject ? 'POWER' : isCoding ? 'CODING' : 'GENERAL',
        recommendedModel: isComplexProject ? 'claude-3-5-sonnet-latest' : isCoding ? 'deepseek-coder:6.7b' : undefined,
      };
    }

    const estimatedTokens = estimatePayloadTokens(messages as any);
    
    // Se o token count for muito grande, provavelmente precisa de raciocínio estendido
    if (estimatedTokens > 2000) {
      return {
        mode: ExecutionMode.WORKFLOW,
        confidence: 0.95,
        isCoding,
        isComplexProject: false,
        recommendedPool: isCoding ? 'CODING' : 'REASONING',
        recommendedModel: isCoding ? 'deepseek-coder:6.7b' : undefined,
      };
    }

    // Se detectou programação diretamente
    if (isCoding) {
      return {
        mode: ExecutionMode.STANDARD,
        confidence: 0.96,
        isCoding: true,
        isComplexProject: false,
        recommendedPool: 'CODING',
        recommendedModel: 'deepseek-coder:6.7b',
      };
    }

    // Heurística de FAST: Perguntas curtas, sem multimídia, poucas mensagens
    if (estimatedTokens < 40 && (!messages || messages.length <= 2)) {
      return {
        mode: ExecutionMode.FAST,
        confidence: 0.98,
        isCoding: false,
        isComplexProject: false,
        recommendedPool: 'FAST',
        recommendedModel: 'qwen2.5:1.5b',
      };
    }

    // Default: STANDARD (maioria das requisições normais)
    return {
      mode: ExecutionMode.STANDARD,
      confidence: 0.90,
      isCoding: false,
      isComplexProject: false,
      recommendedPool: 'GENERAL',
      recommendedModel: 'qwen2.5:3b',
    };
  }

  private static detectComplexProject(text: string): boolean {
    const patterns = [
      /\b(analise|audite|refatore|reformule)\s+(o\s+)?(meu\s+)?(projeto|sistema|repositório|arquitetura)\b/,
      /\b(multi[- ]agent|pipeline\s+completo|roadmap\s+completo|decomponha\s+a\s+tarefa)\b/,
      /\b(arquitetura|microserviços|fullstack|monorepo)\b/,
      /\b(planeje|crie\s+um\s+plano)\s+(de\s+)?(implementação|migração|arquitetura)\b/,
    ];
    return patterns.some((p) => p.test(text));
  }

  private static detectCoding(lower: string, original: string): boolean {
    if (original.includes('```') || original.includes('function ') || original.includes('class ') || original.includes('import ')) {
      return true;
    }

    const languages = [
      /\b(typescript|javascript|python|rust|golang|c\+\+|cpp|c#|csharp|php|ruby|java|kotlin|swift|sql|html|css|bash|shell|powershell|dockerfile)\b/,
    ];
    if (languages.some((rgx) => rgx.test(lower))) {
      return true;
    }

    const codingTerms = [
      /\b(código|codigo|code|programar|programação|programacao|script|função|funcao|endpoint|api|bug|fix|debug|refactor|refatorar)\b/,
      /\b(prisma|database|tabela|query|migration|vitest|jest|unit test|teste unitário|regex|algoritmo|algorithm)\b/,
      /\b(escreva\s+um|crie\s+um|desenvolva\s+um)\s+(código|script|programa|algoritmo|componente|service|controller)\b/,
    ];
    return codingTerms.some((rgx) => rgx.test(lower));
  }
}
