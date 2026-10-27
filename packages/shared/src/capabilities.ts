export type ModelCapability =
  | 'chat'
  | 'reasoning'
  | 'coding'
  | 'vision'
  | 'image'
  | 'embeddings'
  | 'tool_use'
  | 'json'
  | 'long_context'
  | 'fast_response'
  | 'agentic'
  | 'research'
  | 'classification'
  | 'extraction'
  | 'decision';

export type ModelPool =
  | 'FAST'
  | 'GENERAL'
  | 'CODING'
  | 'REASONING'
  | 'VISION'
  | 'EMBEDDING'
  | 'POWER'
  | 'AUTO'
  | 'DECISION';

export interface ModelCapabilityInfo {
  id: string;
  provider: string;
  pools: ModelPool[];
  capabilities: ModelCapability[];
  contextWindow: number;
  maxOutputTokens?: number;
  latencyTier: 'instant' | 'low' | 'medium' | 'high';
  pricingTier: 'free' | 'low' | 'standard' | 'premium';
  status: 'available' | 'configured' | 'discovered' | 'untested' | 'offline';
  description?: string;
}

/**
 * Catálogo canônico de modelos conhecidos e suas capacidades reais verificadas.
 * Zero alucinação: modelos locais refletem a realidade medida da VPS/ambiente local.
 */
export const MODEL_CAPABILITY_CATALOG: ModelCapabilityInfo[] = [
  // --- LOCAL OLLAMA MODELS ---
  {
    id: 'qwen3.5:0.8b',
    provider: 'ollama',
    pools: ['FAST', 'GENERAL'],
    capabilities: ['chat', 'fast_response', 'json', 'classification'],
    contextWindow: 2048,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'available',
    description: 'Modelo local ultraleve para respostas rápidas e classificação básica.',
  },
  {
    id: 'qwen2.5:0.5b',
    provider: 'ollama',
    pools: ['FAST'],
    capabilities: ['chat', 'fast_response'],
    contextWindow: 2048,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'available',
    description: 'Menor modelo Qwen para triagem e reconhecimento instantâneo.',
  },
  {
    id: 'qwen2.5:1.5b',
    provider: 'ollama',
    pools: ['FAST', 'GENERAL'],
    capabilities: ['chat', 'fast_response', 'json', 'extraction'],
    contextWindow: 4096,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'available',
    description: 'Modelo rápido padrão para conversação balanceada local.',
  },
  {
    id: 'qwen2.5:3b',
    provider: 'ollama',
    pools: ['GENERAL', 'CODING'],
    capabilities: ['chat', 'coding', 'json', 'classification', 'extraction'],
    contextWindow: 4096,
    latencyTier: 'medium',
    pricingTier: 'free',
    status: 'available',
    description: 'Modelo intermediário local com suporte a código e tarefas de maior qualidade.',
  },
  {
    id: 'deepseek-r1:1.5b',
    provider: 'ollama',
    pools: ['REASONING'],
    capabilities: ['chat', 'reasoning'],
    contextWindow: 2048,
    latencyTier: 'high',
    pricingTier: 'free',
    status: 'available', // Validado na VPS com modelo DeepSeek-R1 1.5B ativo no Ollama
    description: 'Modelo de raciocínio local (sujeito a latência alta em CPU).',
  },
  {
    id: 'moondream',
    provider: 'ollama',
    pools: ['VISION'],
    capabilities: ['vision', 'chat', 'extraction'],
    contextWindow: 2048,
    latencyTier: 'medium',
    pricingTier: 'free',
    status: 'configured',
    description: 'Modelo compacto multimodal de visão computacional local.',
  },
  {
    id: 'nomic-embed-text',
    provider: 'ollama',
    pools: ['EMBEDDING'],
    capabilities: ['embeddings'],
    contextWindow: 8192,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'available',
    description: 'Modelo local dedicado para geração de embeddings semânticos.',
  },
  {
    id: 'all-minilm',
    provider: 'ollama',
    pools: ['EMBEDDING'],
    capabilities: ['embeddings'],
    contextWindow: 2048,
    latencyTier: 'instant',
    pricingTier: 'free',
    status: 'available',
    description: 'All-MiniLM-L6-v2 Open-Source ultrarrápido para embeddings de 384 dimensões.',
  },
  {
    id: 'gemma3:1b',
    provider: 'ollama',
    pools: ['FAST', 'GENERAL'],
    capabilities: ['chat', 'fast_response', 'json', 'classification', 'extraction', 'reasoning'],
    contextWindow: 32768,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'available',
    description: 'Google Gemma 3 1B Instruct Open-Source — modelo oficial leve do Google para respostas ágeis e estruturadas.',
  },
  {
    id: 'qwen2.5-coder:1.5b',
    provider: 'ollama',
    pools: ['CODING', 'GENERAL', 'FAST'],
    capabilities: ['chat', 'coding', 'json', 'extraction', 'fast_response'],
    contextWindow: 32768,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'available',
    description: 'Qwen 2.5 Coder 1.5B Open-Source — especialista em engenharia de software e programação (equivalente open-source Claude/JEV Coder).',
  },
  {
    id: 'llama3.2:1b',
    provider: 'ollama',
    pools: ['FAST', 'GENERAL'],
    capabilities: ['chat', 'fast_response', 'json', 'tool_use', 'classification', 'reasoning'],
    contextWindow: 131072,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'available',
    description: 'Meta Llama 3.2 1B Instruct Open-Source — conversação geral, instruções e tool use (equivalente open-source ChatGPT).',
  },
  {
    id: 'qwen3.5:0.8b',
    provider: 'ollama',
    pools: ['FAST', 'VISION', 'REASONING'],
    capabilities: ['chat', 'vision', 'reasoning', 'tool_use', 'fast_response', 'json'],
    contextWindow: 32768,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'available',
    description: 'Qwen 3.5 0.8B Open-Source multimodal (Visão, Tool Use e Thinking).',
  },

  // --- FREE-TIER & EXTERNAL PROVIDERS ---
  {
    id: 'llama-3.1-8b-instant',
    provider: 'groq',
    pools: ['FAST', 'GENERAL'],
    capabilities: ['chat', 'fast_response', 'json', 'tool_use', 'classification', 'reasoning'],
    contextWindow: 131072,
    latencyTier: 'instant',
    pricingTier: 'free',
    status: 'configured',
    description: 'Inferência ultrarrápida Llama 3.1 via Groq LPU.',
  },
  {
    id: 'llama-3.3-70b-versatile',
    provider: 'groq',
    pools: ['POWER', 'GENERAL', 'CODING', 'REASONING'],
    capabilities: ['chat', 'coding', 'reasoning', 'json', 'tool_use', 'long_context'],
    contextWindow: 131072,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'configured',
    description: 'Modelo de alta potência via Groq.',
  },
  {
    id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    provider: 'cloudflare',
    pools: ['FAST', 'GENERAL'],
    capabilities: ['chat', 'fast_response', 'json'],
    contextWindow: 8192,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'configured',
    description: 'Cloudflare Workers AI Llama 3.1 com franquia diária gratuita.',
  },
  {
    id: '@cf/baai/bge-m3',
    provider: 'cloudflare',
    pools: ['EMBEDDING'],
    capabilities: ['embeddings'],
    contextWindow: 8192,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'configured',
    description: 'Embeddings multilíngues de alta dimensão via Cloudflare.',
  },
  {
    id: 'openrouter/free',
    provider: 'openrouter',
    pools: ['FAST', 'GENERAL'],
    capabilities: ['chat', 'fast_response'],
    contextWindow: 16384,
    latencyTier: 'medium',
    pricingTier: 'free',
    status: 'configured',
    description: 'Roteamento gratuito dinâmico via OpenRouter.',
  },
  {
    id: 'z-ai/glm-5.2:free',
    provider: 'openrouter',
    pools: ['GENERAL', 'REASONING'],
    capabilities: ['chat', 'reasoning', 'coding'],
    contextWindow: 32768,
    latencyTier: 'medium',
    pricingTier: 'free',
    status: 'configured',
    description: 'GLM 5.2 gratuito via OpenRouter.',
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'gemini',
    pools: ['FAST', 'GENERAL', 'VISION'],
    capabilities: ['chat', 'vision', 'fast_response', 'json', 'tool_use', 'long_context'],
    contextWindow: 1048576,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'configured',
    description: 'Google Gemini Flash multimodal com contexto longo e tier gratuito.',
  },
  {
    id: 'gemini-1.5-pro',
    provider: 'gemini',
    pools: ['POWER', 'REASONING', 'VISION', 'CODING'],
    capabilities: ['chat', 'vision', 'reasoning', 'coding', 'long_context', 'tool_use', 'agentic', 'research'],
    contextWindow: 2097152,
    latencyTier: 'medium',
    pricingTier: 'standard',
    status: 'configured',
    description: 'Google Gemini Pro com 2M tokens de contexto e raciocínio avançado.',
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    pools: ['FAST', 'GENERAL', 'VISION'],
    capabilities: ['chat', 'vision', 'fast_response', 'json', 'tool_use', 'coding'],
    contextWindow: 128000,
    latencyTier: 'low',
    pricingTier: 'low',
    status: 'configured',
    description: 'OpenAI GPT-4o mini ágil e multimodal.',
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    pools: ['POWER', 'CODING', 'REASONING', 'VISION'],
    capabilities: ['chat', 'vision', 'coding', 'reasoning', 'tool_use', 'agentic', 'json'],
    contextWindow: 128000,
    latencyTier: 'low',
    pricingTier: 'standard',
    status: 'configured',
    description: 'OpenAI GPT-4o topo de linha.',
  },
  {
    id: 'claude-3-5-sonnet-latest',
    provider: 'anthropic',
    pools: ['POWER', 'CODING', 'REASONING', 'VISION'],
    capabilities: ['chat', 'vision', 'coding', 'reasoning', 'tool_use', 'agentic', 'research'],
    contextWindow: 200000,
    latencyTier: 'low',
    pricingTier: 'standard',
    status: 'configured',
    description: 'Anthropic Claude 3.5 Sonnet líder em programação e raciocínio.',
  },
  // --- SYSTEM 1 & DECISION MODELS ---
  {
    id: 'laya-system1',
    provider: 'laya',
    pools: ['FAST', 'DECISION'],
    capabilities: ['decision', 'fast_response', 'classification'],
    contextWindow: 4096,
    latencyTier: 'instant',
    pricingTier: 'free',
    status: 'available',
    description: 'System 1 Local ONNX semantic decision and fast classification engine (<35ms).',
  },
  {
    id: 'jev-cloud',
    provider: 'jev',
    pools: ['FAST', 'DECISION', 'GENERAL'],
    capabilities: ['decision', 'fast_response'],
    contextWindow: 8192,
    latencyTier: 'low',
    pricingTier: 'free',
    status: 'available',
    description: 'System 1 Cloud fast classifier and decision model.',
  },
  {
    id: 'deepseek-coder:6.7b',
    provider: 'ollama',
    pools: ['CODING', 'REASONING', 'GENERAL'],
    capabilities: ['chat', 'coding', 'reasoning', 'json'],
    contextWindow: 16384,
    latencyTier: 'medium',
    pricingTier: 'free',
    status: 'available',
    description: 'System 2 DeepSeek-Coder local especializado em desenvolvimento de software.',
  },
  {
    id: 'moonshot-v1-8k',
    provider: 'kimi',
    pools: ['GENERAL', 'CODING', 'REASONING'],
    capabilities: ['chat', 'coding', 'reasoning', 'long_context'],
    contextWindow: 128000,
    latencyTier: 'medium',
    pricingTier: 'low',
    status: 'configured',
    description: 'System 2 Kimi / Moonshot long-context and code reasoning model.',
  },
];

export class ModelCapabilityRegistry {
  private static catalog: Map<string, ModelCapabilityInfo> = new Map(
    MODEL_CAPABILITY_CATALOG.map((m) => [`${m.provider}:${m.id}`, m]),
  );

  /** Registra ou atualiza dinamicamente um modelo no catálogo */
  public static registerModel(info: ModelCapabilityInfo): void {
    this.catalog.set(`${info.provider}:${info.id}`, info);
  }

  /** Retorna a definição do modelo por ID ou provider:id */
  /** Resolve aliases open-source (gemma, claude-open, chatgpt-open, jev-coder, etc.) para o modelo canônico */
  public static resolveModelAlias(alias?: string): string | undefined {
    if (!alias) return undefined;
    const lower = alias.toLowerCase().trim();
    switch (lower) {
      case 'gemma':
      case 'gemma-open':
      case 'gemma3':
      case 'gemma-3':
      case 'google-open':
        return 'gemma3:1b';
      case 'claude-open':
      case 'sonnet-open':
      case 'jev-open':
      case 'jev-coder':
      case 'coder-open':
      case 'qwen-coder':
        return 'qwen2.5-coder:1.5b';
      case 'chatgpt-open':
      case 'gpt-open':
      case 'openai-open':
      case 'llama':
      case 'llama-open':
      case 'llama3.2':
        return 'llama3.2:1b';
      case 'r1-open':
      case 'deepseek-open':
      case 'reasoning-open':
        return 'deepseek-r1:1.5b';
      case 'vision-open':
      case 'qwen-vision':
        return 'qwen3.5:0.8b';
      default:
        return undefined;
    }
  }

  /** Retorna a definição do modelo por ID ou provider:id */
  public static getModel(idOrKey: string): ModelCapabilityInfo | undefined {
    if (this.catalog.has(idOrKey)) {
      return this.catalog.get(idOrKey);
    }
    const resolvedAlias = this.resolveModelAlias(idOrKey);
    const lookupId = resolvedAlias || idOrKey;
    for (const info of this.catalog.values()) {
      if (info.id === lookupId) return info;
    }
    return undefined;
  }

  private static _legacyGetModelUnused(idOrKey: string): ModelCapabilityInfo | undefined {
    if (this.catalog.has(idOrKey)) {
      return this.catalog.get(idOrKey);
    }
    for (const info of this.catalog.values()) {
      if (info.id === idOrKey) return info;
    }
    return undefined;
  }

  /** Lista todos os modelos registrados */
  public static listModels(): ModelCapabilityInfo[] {
    return Array.from(this.catalog.values());
  }

  /** Lista modelos pertencentes a um pool lógico */
  public static getModelsForPool(pool: ModelPool): ModelCapabilityInfo[] {
    if (pool === 'AUTO') return this.listModels();
    return this.listModels().filter((m) => m.pools.includes(pool));
  }

  /** Filtra modelos que satisfazem todas as capacidades requeridas */
  public static filterByCapabilities(
    required: ModelCapability[],
    pool?: ModelPool,
  ): ModelCapabilityInfo[] {
    const list = pool ? this.getModelsForPool(pool) : this.listModels();
    return list.filter((m) => required.every((cap) => m.capabilities.includes(cap)));
  }

  /** Mapeia nomes virtuais (aliases) como 'fast', 'coding', 'reasoning', 'power', 'vision' para o pool correspondente */
  public static resolvePoolFromAlias(alias?: string): ModelPool {
    if (!alias) return 'AUTO';
    const lower = alias.toLowerCase().trim();
    switch (lower) {
      case 'fast':
      case 'quick':
      case 'rapido':
        return 'FAST';
      case 'coding':
      case 'code':
      case 'coder':
      case 'programacao':
      case 'claude-open':
      case 'sonnet-open':
      case 'jev-open':
      case 'jev-coder':
      case 'coder-open':
      case 'qwen-coder':
        return 'CODING';
      case 'reasoning':
      case 'reason':
      case 'think':
      case 'raciocinio':
        return 'REASONING';
      case 'vision':
      case 'visual':
      case 'image':
      case 'visao':
        return 'VISION';
      case 'embedding':
      case 'embed':
        return 'EMBEDDING';
      case 'power':
      case 'strong':
      case 'heavy':
      case 'potente':
        return 'POWER';
      case 'general':
      case 'chat':
      case 'chatgpt-open':
      case 'gpt-open':
      case 'openai-open':
      case 'llama':
      case 'llama-open':
      case 'llama3.2':
      case 'gemma':
      case 'gemma-open':
      case 'gemma3':
        return 'GENERAL';
      case 'decision':
      case 'decide':
      case 'router':
      case 'laya':
      case 'jev':
        return 'DECISION';
      default:
        return 'AUTO';
    }
  }
}
