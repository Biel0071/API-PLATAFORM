import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAccountPool } from '@api-platform/shared';
import { registry } from '../src/services/ai.service';
import { resolveComfyProvider, resolveComfyProviderSelection } from '../src/services/comfy-provider.service';

describe('ComfyUI account selection', () => {
  beforeEach(() => {
    registry.register({ name: 'comfyui', capabilities: ['image'], health: vi.fn(async () => ({ ok: true })) } as any);
  });

  it('selects the explicit account and performs a real health check', async () => {
    const health = vi.fn(async () => ({ ok: true }));
    const selected = { name: 'comfyui', capabilities: ['image'], health } as any;
    registry.setAccountPool(new ProviderAccountPool(async () => [
      { accountId: 'comfy-account', providerName: 'comfyui', provider: selected, enabled: true, healthOk: null, healthCheckedAt: null },
    ], async () => 0));

    expect(await resolveComfyProvider('comfy-account')).toBe(selected);
    expect(health).toHaveBeenCalledOnce();
  });

  it('does not use the legacy provider when configured accounts are stale or unhealthy', async () => {
    const legacyGet = vi.spyOn(registry, 'get');
    registry.setAccountPool(new ProviderAccountPool(async () => [
      { accountId: 'comfy-stale', providerName: 'comfyui', provider: { name: 'comfyui', capabilities: ['image'], health: vi.fn(async () => ({ ok: true })) } as any, enabled: true, healthOk: null, healthCheckedAt: null },
    ], async () => 0));

    await expect(resolveComfyProvider()).rejects.toMatchObject({ code: 'NO_PROVIDER_AVAILABLE' });
    expect(legacyGet).not.toHaveBeenCalled();
  });

  it('returns the selected account id so follow-up calls can address the same instance', async () => {
    const selected = { name: 'comfyui', capabilities: ['image'], health: vi.fn(async () => ({ ok: true })) } as any;
    registry.setAccountPool(new ProviderAccountPool(async () => [
      { accountId: 'comfy-account-a', providerName: 'comfyui', provider: selected, enabled: true, healthOk: true, healthCheckedAt: new Date() },
      { accountId: 'comfy-account-b', providerName: 'comfyui', provider: { ...selected }, enabled: true, healthOk: true, healthCheckedAt: new Date() },
    ], async () => 1));

    const result = await resolveComfyProviderSelection();
    expect(result).toEqual({ provider: selected, providerAccountId: 'comfy-account-b' });
    await expect(resolveComfyProviderSelection(undefined, true)).rejects.toMatchObject({
      code: 'PROVIDER_ACCOUNT_REQUIRED',
      statusCode: 400,
    });
  });

  it('allows follow-up calls without an id when only one account is configured', async () => {
    const selected = { name: 'comfyui', capabilities: ['image'], health: vi.fn(async () => ({ ok: true })) } as any;
    registry.setAccountPool(new ProviderAccountPool(async () => [
      { accountId: 'only-comfy-account', providerName: 'comfyui', provider: selected, enabled: true, healthOk: true, healthCheckedAt: new Date() },
    ], async () => 0));

    expect(await resolveComfyProviderSelection(undefined, true)).toEqual({
      provider: selected,
      providerAccountId: 'only-comfy-account',
    });
  });
});
