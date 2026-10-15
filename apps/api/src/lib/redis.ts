import Redis from 'ioredis';
import { env } from '../config/env';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,
  enableOfflineQueue: false,
});

redis.on('error', () => {
  // Ignora erros de conexão quando o Redis estiver offline para permitir fallback transparente
});

/** Opcoes dedicadas para BullMQ, sem misturar instancias de versoes do ioredis. */
export function createBullConnection() {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}
