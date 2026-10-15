import { ProviderError } from '@api-platform/shared';
import { providerAccountPool, registry } from './ai.service';
import { ComfyUIProvider } from '@api-platform/shared';

export interface ComfyProviderSelection {
  provider: ComfyUIProvider;
  providerAccountId?: string;
}

export async function resolveComfyProviderSelection(
  providerAccountId?: string,
  requireExplicitWhenAmbiguous = false,
): Promise<ComfyProviderSelection> {
  const pool = registry.getAccountPool() ?? providerAccountPool;
  let providers: Array<{ accountId?: string; provider: ComfyUIProvider }> = [];
  if (providerAccountId) {
    const account = await pool.resolveAccount(providerAccountId);
    if (!account || !account.enabled) {
      throw new ProviderError('comfyui', 'Provider account not found or disabled', 'PROVIDER_ACCOUNT_NOT_FOUND', 404, false);
    }
    if (account.providerName !== 'comfyui' || !account.provider.capabilities.includes('image')) {
      throw new ProviderError('comfyui', 'Selected account is incompatible with ComfyUI', 'PROVIDER_ACCOUNT_MISMATCH', 400, false);
    }
    providers = [{ accountId: account.accountId, provider: account.provider as ComfyUIProvider }];
  } else if (await pool.hasConfiguredAccounts('comfyui')) {
    const configured = (await pool.listAccounts()).filter(
      (account) => account.providerName === 'comfyui' && account.enabled && account.provider.capabilities.includes('image'),
    );
    if (requireExplicitWhenAmbiguous && configured.length > 1) {
      throw new ProviderError('comfyui', 'Select the ComfyUI account used to create this workflow', 'PROVIDER_ACCOUNT_REQUIRED', 400, false);
    }
    providers = (await pool.resolveAccounts('comfyui', 'image')).map((account) => ({
      accountId: account.accountId,
      provider: account.provider as ComfyUIProvider,
    }));
  } else if (registry.has('comfyui')) {
    providers = [{ provider: registry.get('comfyui') as ComfyUIProvider }];
  }

  if (!providers.length) {
    throw new ProviderError('comfyui', 'No healthy ComfyUI account is available', 'NO_PROVIDER_AVAILABLE', 503, false);
  }
  for (const selection of providers) {
    try {
      if ((await selection.provider.health()).ok) {
        return { provider: selection.provider, providerAccountId: selection.accountId };
      }
    } catch {
      // Fall through only to another account instance; legacy duplicates are suppressed above.
    }
  }
  throw new ProviderError('comfyui', 'ComfyUI is offline', 'COMFYUI_OFFLINE', 503, true);
}

export async function resolveComfyProvider(providerAccountId?: string): Promise<ComfyUIProvider> {
  return (await resolveComfyProviderSelection(providerAccountId)).provider;
}
