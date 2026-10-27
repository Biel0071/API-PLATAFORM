const excludedProviders = new Set(
  (process.env.PROVIDER_HEALTH_EXCLUDED_PROVIDERS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
);

export function isProviderProbeExcluded(providerName: string): boolean {
  return excludedProviders.has(providerName.trim().toLowerCase());
}
