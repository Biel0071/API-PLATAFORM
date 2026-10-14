interface ProviderCascadeInput {
  model?: string;
  requestedProvider?: string;
  defaultProvider?: string;
  fallbackOrder: string[];
  hasProvider: (name: string) => boolean;
}

function providerFromModel(model: string, hasProvider: (name: string) => boolean): string | undefined {
  const prefix = model.split('/', 1)[0].toLowerCase();
  if (prefix !== model.toLowerCase() && hasProvider(prefix)) return prefix;
  const normalized = model.toLowerCase();
  const family = normalized.includes('claude') ? 'anthropic'
    : normalized.startsWith('gpt-') ? 'openai'
      : normalized.startsWith('gemini-') ? 'gemini'
        : normalized.startsWith('grok-') ? 'xai'
          : undefined;
  return family && hasProvider(family) ? family : undefined;
}

/** Choose explicit provider, provider implied by a model, configured default, then fallbacks. */
export function buildProviderCascade({
  model = 'auto',
  requestedProvider,
  defaultProvider,
  fallbackOrder,
  hasProvider,
}: ProviderCascadeInput): string[] {
  const requested = requestedProvider && requestedProvider.toLowerCase() !== 'auto'
    ? requestedProvider.toLowerCase()
    : undefined;
  const preferred = requested
    || (model.toLowerCase() !== 'auto' ? providerFromModel(model, hasProvider) : undefined)
    || (defaultProvider && hasProvider(defaultProvider) ? defaultProvider : undefined);
  const knownFallbacks = fallbackOrder.filter((name, index) => name && fallbackOrder.indexOf(name) === index);
  if (preferred && hasProvider(preferred)) {
    return [preferred, ...knownFallbacks.filter((name) => name !== preferred)];
  }
  return knownFallbacks;
}
