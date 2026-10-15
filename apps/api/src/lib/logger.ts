import pino from 'pino';
import { env } from '../config/env';

interface RequestLogSource {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

export function serializeRequestForLog(request: RequestLogSource) {
  const queryStart = request.url?.indexOf('?') ?? -1;
  return {
    method: request.method,
    url: queryStart >= 0 ? request.url?.slice(0, queryStart) : request.url,
    version: request.headers?.['accept-version'],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

export const logger = pino({
  level: env.LOG_LEVEL,
  serializers: { req: serializeRequestForLog },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
