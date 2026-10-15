import { expect, it, vi } from 'vitest';
const checks = vi.hoisted(() => ({
  online: vi.fn(async () => ({ ok: true })),
  offline: vi.fn(async () => ({ ok: false })),
  broken: vi.fn(async () => { throw new Error('connection failed'); }),
}));
vi.mock('../../apps/api/src/services/ai.service', () => ({ registry: {
  list: () => Object.entries(checks).map(([name, health]) => ({ name, health })),
} }));
import { providerHealthState, refreshProviderHealth } from '../../apps/api/src/services/health-check.service';

it('measures providers rather than marking registration as healthy', async () => {
  await refreshProviderHealth();
  expect(providerHealthState.get('online')?.status).toBe('healthy');
  expect(providerHealthState.get('offline')?.status).toBe('offline');
  expect(providerHealthState.get('broken')?.status).toBe('offline');
  for (const check of Object.values(checks)) expect(check).toHaveBeenCalledOnce();
});
