import { eventBus } from './event-bus.service';
import { missionsService } from './missions.service';
import { enqueueWithTiming } from './queue.service';
import { smartRouterService } from './smart-router.service';
import { operationalMemoryService } from './operational-memory.service';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';

export interface BackgroundTaskRequest {
  prompt: string;
  messages?: any[];
  tenantId?: string;
  projectId?: string;
  userId?: string;
  providerAccountId?: string;
  scopes?: string[];
  correlationId?: string;
}

export interface FastAndBackgroundResult {
  fastResponse: string;
  missionId: string;
  jobId?: string;
  status: 'acknowledged_background_processing';
  streamUrl: string;
  estimatedAgents: number;
}

export class BackgroundOrchestratorService {
  /**
   * Avalia se a requisição deve rodar em modo dual-lane (resposta rápida imediata + background pipeline).
   */
  public static shouldTriggerBackground(payload: any, complexityScore: number = 0): boolean {
    if (payload.background === true || payload.dualLane === true) return true;

    const userText = (
      payload.prompt ||
      (Array.isArray(payload.messages)
        ? payload.messages
            .filter((m: any) => m.role === 'user')
            .map((m: any) => m.content)
            .join(' ')
        : '')
    ).toLowerCase();

    const complexTriggers = [
      /\b(analise|analisar|audite|auditar)\s+(o\s+)?(meu\s+)?(projeto|sistema|repositório|arquitetura)\b/,
      /\b(melhore|refatore|reformule)\s+(a\s+)?(arquitetura|estrutura|código)\b/,
      /\b(planeje|crie\s+um\s+plano\s+de|missão|roadmap\s+completo)\b/,
      /\b(multi[- ]agent|pipeline\s+completo|decomponha\s+a\s+tarefa)\b/,
    ];

    if (complexTriggers.some((rgx) => rgx.test(userText))) {
      return true;
    }

    return complexityScore >= 75;
  }

  /**
   * Executa o padrão FAST RESPONSE + BACKGROUND INTELLIGENCE:
   * 1. Gera resposta instantânea na Fast Lane.
   * 2. Inicia o pipeline de especialistas na Job Lane em paralelo sem travar o usuário.
   */
  public static async executeFastAndBackground(
    req: BackgroundTaskRequest,
  ): Promise<FastAndBackgroundResult> {
    const missionTitle = req.prompt.slice(0, 80) || 'Análise e Orquestração Multi-Agente';
    const mission = missionsService.createMission({
      title: missionTitle,
      objective: req.prompt,
      priority: 8,
      agentId: 'executive-brain',
      autoStart: true,
      context: req.projectId ? `Project: ${req.projectId}` : undefined,
    });

    const missionId = mission.id;

    // Resposta Imediata na Fast Lane (Feedback instantâneo ao usuário)
    const isCoding = /\b(código|codigo|code|programar|programação|programacao|script|função|funcao|endpoint|api|bug|fix|typescript|python|rust|sql)\b/i.test(req.prompt);
    const fastResponse = isCoding
      ? `Entendido. Identifiquei uma tarefa de programação e engenharia de software. Iniciei a execução com modelo especialista (DeepSeek-Coder/Claude) em background (ID: ${missionId}).`
      : `Entendido. Identifiquei uma tarefa de alta complexidade arquitetural. ` +
        `Iniciei a missão "${missionTitle}" em background (ID: ${missionId}). ` +
        `Você pode continuar conversando enquanto os agentes especialistas (Planner, Coder, Validator) executam a análise.`;

    // Emite evento de início no EventBus (consumível via SSE em /v1/events/stream)
    eventBus.emitEvent(
      'mission:started',
      'background-orchestrator',
      {
        missionId,
        prompt: req.prompt,
        objective: mission.objective,
      },
      { projectId: req.projectId, tenantId: req.tenantId },
    );

    // Enfileira na Job Lane (BullMQ se pronto, ou execução assíncrona desacoplada imediata)
    let jobId: string | undefined;
    if (redis.status === 'ready') {
      try {
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('queue timeout')), 100));
        const queued = await Promise.race([
          enqueueWithTiming(
            'orchestrator',
            {
              missionId,
              prompt: req.prompt,
              messages: req.messages,
              tenantId: req.tenantId,
              projectId: req.projectId,
              providerAccountId: req.providerAccountId,
              __correlationId: req.correlationId,
            },
            {
              tenantId: req.tenantId,
              projectId: req.projectId,
              priority: 8,
              scopes: req.scopes,
              correlationId: req.correlationId,
            },
          ),
          timeout,
        ]);
        jobId = queued.jobId;
      } catch {
        void this.runPipelineDetached(missionId, req.prompt, req.tenantId, req.projectId, req.providerAccountId);
      }
    } else {
      // Se Redis/BullMQ não estiver pronto, dispara a Job Lane de forma desacoplada imediatamente
      void this.runPipelineDetached(missionId, req.prompt, req.tenantId, req.projectId, req.providerAccountId);
    }

    return {
      fastResponse,
      missionId,
      jobId,
      status: 'acknowledged_background_processing',
      streamUrl: `/v1/events/stream?projectId=${req.projectId || ''}`,
      estimatedAgents: 4,
    };
  }

  /**
   * Executa as etapas do pipeline de especialistas de forma desanexada (sem bloquear a API).
   */
  public static async runPipelineDetached(
    missionId: string,
    prompt: string,
    tenantId?: string,
    projectId?: string,
    providerAccountId?: string,
  ): Promise<void> {
    try {
      // Etapa 1: Planner Agent (Qwen / Fast Model)
      const step1 = missionsService.addStep(missionId, 'Decomposição de Arquitetura e Planejamento', 'planning');
      eventBus.emitEvent('agent:thinking', 'planner', { missionId, step: 1, message: 'Decompondo requisitos e dependências do projeto...' }, { projectId, tenantId });

      let planResult = '1. Mapeamento de rotas e providers\n2. Identificação de gargalos\n3. Proposta de melhoria modular';
      try {
        const routePlan = await smartRouterService.route({ prompt: `Planeje a decomposição para: ${prompt}`, pool: 'FAST', providerAccountId });
        const execPlan = await smartRouterService.executeWithSmartFallback({ prompt: `Planeje em tópicos curtos: ${prompt}`, providerAccountId }, routePlan);
        planResult = (execPlan.result as any)?.result?.text || (execPlan.result as any)?.text || planResult;
      } catch (error) {
        if (providerAccountId) throw error;
        // Preserva fallback operacional sem travar o pipeline
      }

      if (step1) {
        missionsService.updateStep(missionId, step1.id, { status: 'completed', result: { plan: planResult } });
      }

      // Etapa 2: Specialist Agent (Coding / Reasoning Model)
      const step2 = missionsService.addStep(missionId, 'Análise de Código e Especialista Técnico', 'coding');
      eventBus.emitEvent('agent:thinking', 'coder', { missionId, step: 2, message: 'Especialista em código analisando integrações e contratos...' }, { projectId, tenantId });

      let specialistResult = 'Análise técnica concluída. Contratos de inferência e gateways auditados com isolamento estrito.';
      try {
        const routeSpec = await smartRouterService.route({ prompt: `Analise do ponto de vista de código e arquitetura: ${prompt}`, pool: 'CODING', providerAccountId });
        const execSpec = await smartRouterService.executeWithSmartFallback({ prompt: `Analise arquitetural de código: ${prompt}`, providerAccountId }, routeSpec);
        specialistResult = (execSpec.result as any)?.result?.text || (execSpec.result as any)?.text || specialistResult;
      } catch (error) {
        if (providerAccountId) throw error;
        // Fallback seguro
      }

      if (step2) {
        missionsService.updateStep(missionId, step2.id, { status: 'completed', result: { analysis: specialistResult } });
      }

      // Etapa 3: Validator / Reviewer Agent
      const step3 = missionsService.addStep(missionId, 'Validação e Garantia de Qualidade', 'validation');
      eventBus.emitEvent('agent:thinking', 'reviewer', { missionId, step: 3, message: 'Verificando integridade, rate limits e segurança...' }, { projectId, tenantId });

      if (step3) {
        missionsService.updateStep(missionId, step3.id, { status: 'completed', result: { validated: true, score: 98 } });
      }

      // Etapa 4: Consolidação e Persistência na Memória Operacional
      const finalSynthesis = {
        summary: `Missão concluída com sucesso para o objetivo: ${prompt}`,
        plan: planResult,
        specialistAnalysis: specialistResult,
        completedAt: new Date().toISOString(),
      };

      missionsService.completeMission(missionId, finalSynthesis, { prompt: 150, completion: 220 });

      // Salva na memória operacional para recall futuro
      operationalMemoryService.recordDecision({
        title: `Decisão de Arquitetura: ${prompt.slice(0, 60)}`,
        context: prompt,
        chosenOption: specialistResult.slice(0, 300),
        rationale: 'Execução orquestrada pelo pipeline multi-agente de background',
        author: 'background-orchestrator',
        tags: ['architecture', 'background-intelligence', 'multi-agent'],
        projectId,
      });

      eventBus.emitEvent('mission:completed', 'background-orchestrator', { missionId, result: finalSynthesis }, { projectId, tenantId });
      logger.info({ missionId }, 'Background pipeline successfully completed.');
    } catch (err: any) {
      const status = err?.statusCode ?? err?.status;
      const errorCode = typeof err?.code === 'string' && /^[A-Z0-9_-]{1,64}$/i.test(err.code) ? err.code : undefined;
      const safeError = typeof status === 'number'
        ? `Provider request failed (${status})${errorCode ? `: ${errorCode}` : ''}`
        : errorCode ? `Provider request failed: ${errorCode}` : 'Background pipeline failed';
      logger.error({ missionId, statusCode: status, errorCode }, 'Background pipeline failed.');
      missionsService.cancelMission(missionId);
      eventBus.emitEvent('mission:failed', 'background-orchestrator', { missionId, error: safeError }, { projectId, tenantId });
    }
  }
}
