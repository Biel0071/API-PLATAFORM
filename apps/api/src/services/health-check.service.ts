import { registry } from './ai.service';
import { logger } from '../lib/logger';

const HEALTH_CHECK_INTERVAL_MS = Math.max(60_000, Number(process.env.PROVIDER_HEALTH_INTERVAL_MS || 120_000));
let healthCheckTimer: NodeJS.Timeout | null = null;
let checking = false;

export const providerHealthState = new Map<string, { status: 'healthy' | 'degraded' | 'offline', latency: number, lastCheck: number }>();

export async function refreshProviderHealth() {
  if (checking) return;
  checking = true;
  try {
    await Promise.all(registry.list().map(async (provider) => {
      const start = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const health = await Promise.race([
          provider.health(),
          new Promise<{ ok: boolean }>(resolve => { timer = setTimeout(() => resolve({ ok: false }), Number(process.env.PROVIDER_HEALTH_TIMEOUT_MS || 70_000)); }),
        ]);
        providerHealthState.set(provider.name, { status: health.ok ? 'healthy' : 'offline', latency: Date.now() - start, lastCheck: Date.now() });
      } catch {
        providerHealthState.set(provider.name, { status: 'offline', latency: Date.now() - start, lastCheck: Date.now() });
      } finally { clearTimeout(timer); }
    }));
  } finally { checking = false; }
}

export function startHealthCheckWorker() {
  if (healthCheckTimer) return;
  
  logger.info('[HealthCheck] Iniciando worker assincrono de verificacao de providers');
  
  void refreshProviderHealth();
  healthCheckTimer = setInterval(() => void refreshProviderHealth(), HEALTH_CHECK_INTERVAL_MS);
  healthCheckTimer.unref();
}

export function stopHealthCheckWorker() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}
