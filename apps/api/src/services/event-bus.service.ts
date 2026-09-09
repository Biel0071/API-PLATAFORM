import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../lib/logger';

export interface SystemEvent {
  id: string;
  timestamp: string;
  type: string;
  source: string;
  data: Record<string, unknown>;
  severity: 'info' | 'warn' | 'error' | 'critical';
  projectId?: string;
  tenantId?: string;
}

export class EventBusService extends EventEmitter {
  private static instance: EventBusService;
  private history: SystemEvent[] = [];
  private readonly maxHistory = 1000;

  private constructor() {
    super();
    this.setMaxListeners(200);
  }

  public static getInstance(): EventBusService {
    if (!EventBusService.instance) {
      EventBusService.instance = new EventBusService();
    }
    return EventBusService.instance;
  }

  public emitEvent(
    type: string,
    source: string,
    data: Record<string, unknown> = {},
    options: { severity?: 'info' | 'warn' | 'error' | 'critical'; projectId?: string; tenantId?: string } = {},
  ): SystemEvent {
    const event: SystemEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      source,
      data,
      severity: options.severity ?? 'info',
      projectId: options.projectId,
      tenantId: options.tenantId,
    };

    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    this.emit('event', event);
    this.emit(`event:${type}`, event);
    logger.debug({ eventId: event.id, type, source }, 'EventBus: event emitted');
    return event;
  }

  public getHistory(filter?: {
    type?: string;
    source?: string;
    severity?: string;
    projectId?: string;
    limit?: number;
  }): SystemEvent[] {
    let result = [...this.history];
    if (filter?.type) {
      result = result.filter((e) => e.type.startsWith(filter.type!));
    }
    if (filter?.source) {
      result = result.filter((e) => e.source === filter.source);
    }
    if (filter?.severity) {
      result = result.filter((e) => e.severity === filter.severity);
    }
    if (filter?.projectId) {
      result = result.filter((e) => e.projectId === filter.projectId);
    }
    const limit = filter?.limit ?? 100;
    return result.slice(-limit).reverse();
  }

  public handleSseStream(req: FastifyRequest, reply: FastifyReply): void {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.flushHeaders?.();

    // Initial connection message
    const welcome = `event: connected\ndata: ${JSON.stringify({ status: 'connected', time: new Date().toISOString() })}\n\n`;
    reply.raw.write(welcome);

    // Replay missed events if client reconnects with Last-Event-ID
    const lastEventId = (req.headers['last-event-id'] as string) || (req.query as Record<string, string>)?.lastEventId;
    if (lastEventId) {
      const lastIndex = this.history.findIndex((e) => e.id === lastEventId);
      if (lastIndex !== -1) {
        const missedEvents = this.history.slice(lastIndex + 1);
        for (const missed of missedEvents) {
          reply.raw.write(`id: ${missed.id}\nevent: ${missed.type}\ndata: ${JSON.stringify(missed)}\n\n`);
        }
      }
    }

    const onEvent = (event: SystemEvent) => {
      try {
        const payload = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        reply.raw.write(payload);
      } catch (err) {
        logger.warn({ err }, 'EventBus: error writing to SSE stream');
      }
    };

    this.on('event', onEvent);

    // Keep-alive heartbeat every 15s
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`event: ping\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      this.off('event', onEvent);
    });
  }
}

export const eventBus = EventBusService.getInstance();
