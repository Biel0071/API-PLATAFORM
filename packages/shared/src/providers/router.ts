import { ProviderRegistry } from './registry';
import { Capability, ChatInput, ChatMessage, ProviderResponse } from '../types';

export type ModelTier = 'strong' | 'fast' | 'reasoning' | 'vision';

export const ModelTiers: Record<ModelTier, string[]> = {
  strong: [
    'gpt-4o',
    'claude-3-5-sonnet-20240620',
    'claude-3-5-sonnet-latest',
    'gemini-1.5-pro',
    'gemini-1.5-pro-exp-0801',
    'gpt-4-turbo'
  ],
  fast: [
    'gpt-4o-mini',
    'claude-3-haiku-20240307',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'llama-3.1-8b-instant',
    '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    'grok-beta'
  ],
  reasoning: [
    'o1-preview',
    'o1-mini'
  ],
  vision: [
    'gpt-4o',
    'gpt-4o-mini',
    'claude-3-5-sonnet-20240620',
    'gemini-1.5-pro',
    'gemini-1.5-flash'
  ]
};

/**
 * Static mapping to resolve the default provider name for a given model.
 * Used for fast dispatch without querying models() on all providers.
 */
export const ProviderModelMap: Record<string, string> = {
  // OpenAI
  'gpt-4o': 'openai',
  'gpt-4o-mini': 'openai',
  'gpt-4-turbo': 'openai',
  'o1-preview': 'openai',
  'o1-mini': 'openai',
  'text-embedding-3-small': 'openai',
  'text-embedding-3-large': 'openai',
  
  // Anthropic
  'claude-3-5-sonnet-20240620': 'anthropic',
  'claude-3-5-sonnet-latest': 'anthropic',
  'claude-3-haiku-20240307': 'anthropic',
  
  // Gemini
  'gemini-1.5-pro': 'gemini',
  'gemini-1.5-flash': 'gemini',
  'gemini-1.5-flash-8b': 'gemini',
  'gemini-1.5-pro-exp-0801': 'gemini',
  
  // Groq
  'llama-3.1-8b-instant': 'groq',
  'llama-3.1-70b-versatile': 'groq',
  'llama3-8b-8192': 'groq',
  
  // Cloudflare
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast': 'cloudflare',
  
  // X.AI
  'grok-beta': 'xai'
};

export class ModelRouter {
  constructor(private readonly registry: ProviderRegistry) {}

  /**
   * Identifies the best provider for a specific model based on static mapping.
   */
  resolveProviderForModel(model: string, fallbackCapability: Capability = 'chat'): string | undefined {
    // Exact match
    if (ProviderModelMap[model]) {
      return ProviderModelMap[model];
    }
    
    // Partial match fallback
    for (const [key, provider] of Object.entries(ProviderModelMap)) {
      if (model.includes(key)) return provider;
    }

    // Default to undefined if no match is found
    return undefined;
  }

  /**
   * Selects a model based on the required tier.
   */
  getModelByTier(tier: ModelTier): string {
    const models = ModelTiers[tier];
    return models[0]; // Retorna o mais recomendado/default para o tier
  }

  /**
   * Executes a ChatInput across multiple models simultaneously (Fan-out).
   * @param input The base chat input containing messages and optional tools.
   * @param models An array of model names or a specific Tier to execute on.
   */
  async executeMultiModel(
    input: ChatInput,
    models: string[] | { tier: ModelTier }
  ): Promise<ProviderResponse<{ message: ChatMessage }>[]> {
    
    let targetModels: string[];
    
    if (Array.isArray(models)) {
      targetModels = models;
    } else {
      targetModels = ModelTiers[models.tier];
    }

    const promises = targetModels.map(async (model) => {
      let providerName = this.resolveProviderForModel(model, 'chat');
      let provider;

      if (providerName && this.registry.has(providerName)) {
        provider = this.registry.get(providerName);
      } else {
        // Fallback para resolver dinamicamente caso o provider nao mapeado
        provider = await this.registry.resolve('chat');
      }

      // Clone input to isolate specific model execution
      const modelInput = { ...input, model };
      
      return provider.chat(modelInput);
    });

    return Promise.all(promises);
  }
}
