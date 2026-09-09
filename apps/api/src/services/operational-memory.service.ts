import { randomUUID } from 'node:crypto';
import { eventBus } from './event-bus.service';
import { logger } from '../lib/logger';

export interface DecisionRecord {
  id: string;
  title: string;
  context: string;
  alternatives?: string[];
  chosenOption: string;
  rationale: string;
  author: string;
  projectId?: string;
  tags?: string[];
  createdAt: string;
}

export interface ErrorResolutionRecord {
  id: string;
  projectId?: string;
  errorType?: string;
  errorMessage: string;
  stackTrace?: string;
  rootCause: string;
  resolutionApplied: string;
  filesChanged?: string[];
  regressionTest?: string;
  verified: boolean;
  createdAt: string;
}

export class OperationalMemoryService {
  private static instance: OperationalMemoryService;
  private decisions: Map<string, DecisionRecord> = new Map();
  private errorResolutions: Map<string, ErrorResolutionRecord> = new Map();

  private constructor() {
    this.seedInitialMemory();
  }

  public static getInstance(): OperationalMemoryService {
    if (!OperationalMemoryService.instance) {
      OperationalMemoryService.instance = new OperationalMemoryService();
    }
    return OperationalMemoryService.instance;
  }

  private seedInitialMemory(): void {
    const now = new Date().toISOString();
    // Seed important historical decisions for FENIX OS
    const d1: DecisionRecord = {
      id: 'dec_fenix_001',
      title: 'Adoção da API Fastify Gateway como Núcleo Operacional do FÊNIX OS',
      context: 'Necessidade de centralizar inferência de IA, filas de background BullMQ, observabilidade e gerenciamento de múltiplos repositórios sem duplicar infraestrutura.',
      alternatives: [
        'Criar um segundo gateway interno dentro do FÊNIX OS',
        'Acoplar chamadas diretas aos SDKs dos provedores no processo desktop',
        'Transformar a API Fastify existente em plataforma operacional robusta com contratos estáveis',
      ],
      chosenOption: 'Transformar a API Fastify existente em plataforma operacional robusta com contratos estáveis',
      rationale: 'Preserva a arquitetura de alta performance (Fastify 5 + BullMQ + Redis + PostgreSQL), elimina retrabalho e fornece telemetria em tempo real compartilhada.',
      author: 'Arquiteto-Chefe FÊNIX',
      tags: ['architecture', 'gateway', 'fenix_os', 'production'],
      createdAt: now,
    };
    this.decisions.set(d1.id, d1);

    const d2: DecisionRecord = {
      id: 'dec_fenix_002',
      title: 'Polimento de Polling Assíncrono com Fallback Resiliente (HTTP 202 -> GET /v1/jobs/:id)',
      context: 'Sob alta carga de concorrência, o gateway enfileira e responde HTTP 202. O cliente precisa aguardar ativamente o término do job sem retornar texto vazio.',
      alternatives: [
        'Travar a requisição em HTTP síncrono infinito (causa timeout no Cloudflare e Nginx)',
        'Devolver erro 429 estrito',
        'Contrato assíncrono 202 + consulta do job com tolerância a picos',
      ],
      chosenOption: 'Contrato assíncrono 202 + consulta do job com tolerância a picos',
      rationale: 'Permite absorver rajadas intensas de chamadas mantendo previsibilidade e evitando falsos negativos.',
      author: 'Arquiteto-Chefe FÊNIX',
      tags: ['queue', 'bullmq', 'async', 'concurrency'],
      createdAt: now,
    };
    this.decisions.set(d2.id, d2);

    // Seed error resolution records
    const e1: ErrorResolutionRecord = {
      id: 'err_fenix_001',
      errorType: 'GATEWAY_TIMEOUT_EMPTY_REPLY',
      errorMessage: 'Node mata o socket por inatividade antes do Ollama em CPU concluir inferência longa.',
      rootCause: 'connectionTimeout era menor que o tempo de geração do modelo de linguagem em CPU (30-50s).',
      resolutionApplied: 'Configurado connectionTimeout >= requestTimeout (300.000ms) e keepAliveTimeout 72.000ms no buildApp Fastify.',
      filesChanged: ['apps/api/src/app.ts'],
      regressionTest: 'tests/quality.test.ts',
      verified: true,
      createdAt: now,
    };
    this.errorResolutions.set(e1.id, e1);
  }

  public recordDecision(data: Omit<DecisionRecord, 'id' | 'createdAt'>): DecisionRecord {
    const id = `dec_${randomUUID().slice(0, 8)}`;
    const decision: DecisionRecord = {
      ...data,
      id,
      createdAt: new Date().toISOString(),
    };
    this.decisions.set(id, decision);
    eventBus.emitEvent('memory:decision_recorded', 'operational_memory', { decisionId: id, title: decision.title });
    return decision;
  }

  public listDecisions(filter?: { projectId?: string; tag?: string }): DecisionRecord[] {
    let list = Array.from(this.decisions.values());
    if (filter?.projectId) {
      list = list.filter((d) => d.projectId === filter.projectId);
    }
    if (filter?.tag) {
      list = list.filter((d) => d.tags?.includes(filter.tag!));
    }
    return list.reverse();
  }

  public getDecision(id: string): DecisionRecord | undefined {
    return this.decisions.get(id);
  }

  public recordErrorResolution(data: Omit<ErrorResolutionRecord, 'id' | 'createdAt'>): ErrorResolutionRecord {
    const id = `err_${randomUUID().slice(0, 8)}`;
    const resolution: ErrorResolutionRecord = {
      ...data,
      id,
      createdAt: new Date().toISOString(),
    };
    this.errorResolutions.set(id, resolution);
    eventBus.emitEvent('memory:error_resolved', 'operational_memory', { resolutionId: id, errorMessage: resolution.errorMessage });
    return resolution;
  }

  public listErrorResolutions(filter?: { projectId?: string; errorType?: string }): ErrorResolutionRecord[] {
    let list = Array.from(this.errorResolutions.values());
    if (filter?.projectId) {
      list = list.filter((e) => e.projectId === filter.projectId);
    }
    if (filter?.errorType) {
      list = list.filter((e) => e.errorType === filter.errorType);
    }
    return list.reverse();
  }

  public findResolutionForError(errorMessage: string): ErrorResolutionRecord | undefined {
    const lower = errorMessage.toLowerCase();
    return Array.from(this.errorResolutions.values()).find((e) =>
      lower.includes(e.errorMessage.toLowerCase()) || e.errorMessage.toLowerCase().includes(lower)
    );
  }

  public searchMemory(query: string): { decisions: DecisionRecord[]; resolutions: ErrorResolutionRecord[] } {
    const q = query.toLowerCase();
    const matchedDecisions = Array.from(this.decisions.values()).filter((d) =>
      d.title.toLowerCase().includes(q) ||
      d.context.toLowerCase().includes(q) ||
      d.rationale.toLowerCase().includes(q) ||
      d.chosenOption.toLowerCase().includes(q) ||
      d.tags?.some((t) => t.toLowerCase().includes(q))
    );

    const matchedResolutions = Array.from(this.errorResolutions.values()).filter((e) =>
      e.errorMessage.toLowerCase().includes(q) ||
      e.rootCause.toLowerCase().includes(q) ||
      e.resolutionApplied.toLowerCase().includes(q) ||
      e.errorType?.toLowerCase().includes(q)
    );

    return {
      decisions: matchedDecisions,
      resolutions: matchedResolutions,
    };
  }
}

export const operationalMemoryService = OperationalMemoryService.getInstance();
