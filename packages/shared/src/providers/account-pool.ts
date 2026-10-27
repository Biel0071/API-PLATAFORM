import { AIProvider, Capability, ProviderError } from '../types';
import { ProviderRegistry } from './registry';

export interface ProviderAccountBinding {
  accountId: string;
  providerName: string;
  provider: AIProvider;
  enabled: boolean;
  configured?: boolean;
  healthOk: boolean | null;
  healthCheckedAt: Date | null;
  healthLatencyMs?: number | null;
  authMode?: 'apiKey' | 'oauth' | 'local';
  accountTier?: string;
  defaultModel?: string;
}

export interface ProviderAccountTarget {
  accountId: string;
  providerName: string;
  provider: AIProvider;
}

export type ProviderAccountLoader = () => Promise<ProviderAccountBinding[]>;
export type ProviderAccountNextIndex = (providerName: string, count: number) => Promise<number>;

export class ProviderAccountPool {
  constructor(
    private readonly loadAccounts: ProviderAccountLoader,
    private readonly nextIndex: ProviderAccountNextIndex,
    private readonly healthMaxAgeMs = 60_000,
  ) {}

  async listAccounts(): Promise<ProviderAccountBinding[]> {
    return this.loadAccounts();
  }

  async resolveAccount(accountId: string): Promise<ProviderAccountBinding | undefined> {
    return (await this.loadAccounts()).find((account) => account.accountId === accountId);
  }

  async resolveAccounts(
    providerName: string,
    capability: Capability,
    selectedAccountId?: string,
  ): Promise<ProviderAccountBinding[]> {
    const accounts = (await this.loadAccounts()).filter(
      (account) => account.providerName === providerName && account.enabled,
    );
    if (selectedAccountId) {
      const selected = accounts.find((account) => account.accountId === selectedAccountId);
      if (!selected) {
        const existsForAnotherProvider = (await this.loadAccounts()).some(
          (account) => account.accountId === selectedAccountId,
        );
        throw new ProviderError(
          providerName,
          existsForAnotherProvider
            ? 'selected account belongs to a different provider'
            : 'selected provider account was not found or is disabled',
          existsForAnotherProvider ? 'PROVIDER_ACCOUNT_MISMATCH' : 'PROVIDER_ACCOUNT_NOT_FOUND',
          existsForAnotherProvider ? 400 : 404,
          false,
        );
      }
      if (!selected.provider.capabilities.includes(capability)) {
        throw new ProviderError(
          providerName,
          `selected account does not support capability "${capability}"`,
          'CAPABILITY_NOT_SUPPORTED',
          400,
          false,
        );
      }
      return [selected];
    }

    const now = Date.now();
    const eligible = accounts.filter(
      (account) =>
        account.provider.capabilities.includes(capability) &&
        account.healthOk === true &&
        account.healthCheckedAt !== null &&
        now - account.healthCheckedAt.getTime() <= this.healthMaxAgeMs,
    );
    if (eligible.length < 2) return eligible;
    const index = await this.nextIndex(providerName, eligible.length);
    const start = ((Math.trunc(index) % eligible.length) + eligible.length) % eligible.length;
    return [...eligible.slice(start), ...eligible.slice(0, start)];
  }

  async hasConfiguredAccounts(providerName: string): Promise<boolean> {
    return (await this.loadAccounts()).some((account) => account.providerName === providerName);
  }
}

/** Resolve account instances before other providers, suppressing their legacy duplicate. */
export async function resolveProviderAccountTargets(
  registry: ProviderRegistry,
  pool: ProviderAccountPool,
  capability: Capability,
  requestedProvider?: string,
  selectedAccountId?: string,
): Promise<ProviderAccountTarget[]> {
  if (selectedAccountId) {
    const selected = await pool.resolveAccount(selectedAccountId);
    if (!selected) {
      throw new ProviderError(
        requestedProvider ?? 'provider-account',
        'selected provider account was not found or is disabled',
        'PROVIDER_ACCOUNT_NOT_FOUND',
        404,
        false,
      );
    }
    if (requestedProvider && selected.providerName !== requestedProvider) {
      throw new ProviderError(
        requestedProvider,
        'selected account belongs to a different provider',
        'PROVIDER_ACCOUNT_MISMATCH',
        400,
        false,
      );
    }
    return (await pool.resolveAccounts(selected.providerName, capability, selectedAccountId)).map(
      ({ accountId, providerName, provider }) => ({ accountId, providerName, provider }),
    );
  }

  const providers = await registry.resolveCandidates(capability, requestedProvider);
  const targets: ProviderAccountTarget[] = [];
  for (const provider of providers) {
    if (await pool.hasConfiguredAccounts(provider.name)) {
      const accounts = await pool.resolveAccounts(provider.name, capability);
      targets.push(
        ...accounts.map(({ accountId, providerName, provider: instance }) => ({
          accountId,
          providerName,
          provider: instance,
        })),
      );
      continue;
    }
    targets.push({ accountId: '', providerName: provider.name, provider });
  }
  return targets;
}
