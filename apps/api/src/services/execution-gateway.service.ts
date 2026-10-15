import { 
  ExecutionContext, 
  ExecutionMode, 
  ExecutionTransport,
  ProviderResponse, 
  Capability,
  ProviderError,
  MemoryExecutionTracer,
  LayaProvider,
  createProviderAttemptContext,
} from '@api-platform/shared';
import { cacheService } from './cache.service';
import { ComplexityAnalyzer } from './complexity.analyzer';
import { FastIntentClassifier } from './intent.classifier';
import { ExecutionDispatcher } from './dispatcher.service';
import { compressContext, getModelTraits } from '@api-platform/shared';
import { registry, providerCircuit, fallbackOrder, providerAccountPool } from './ai.service';
import { enqueueAndWait } from './queue.service';
import { apiLayerTools, APILayerRegistry } from './apilayer.registry';
import crypto from 'crypto';
import { TaskClassifier } from './task-classifier.service';
import { PromptOptimizer } from './prompt-optimizer.service';
import { rememberExecutionSuccess } from './execution-memory.service';
import { refineResponse } from './refinement.service';
import { smartRouterService } from './smart-router.service';
import { BackgroundOrchestratorService } from './background-orchestrator.service';
import { providerAttemptTracker } from './provider-attempt.service';

function isTransientProviderFailure(error: any): boolean {
  const status = error?.statusCode ?? error?.status;
  if (typeof status === 'number') return status === 408 || status === 425 || status === 429 || status >= 500;
  return error?.retryable === true || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error?.code ?? '');
}

function safeProviderFailure(error: any): { statusCode?: number; errorCode?: string; message: string } {
  const statusCode = error?.statusCode ?? error?.status;
  const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,64}$/i.test(error.code) ? error.code : undefined;
  return {
    statusCode: typeof statusCode === 'number' ? statusCode : undefined,
    errorCode,
    message: typeof statusCode === 'number'
      ? `Provider request failed (${statusCode})${errorCode ? `: ${errorCode}` : ''}`
      : errorCode ? `Provider request failed: ${errorCode}` : 'Provider request failed',
  };
}

export interface Executor {
  execute(ctx: ExecutionContext, input: any): Promise<ProviderResponse<any>>;
}

export class DirectExecutor implements Executor {
  async execute(ctx: ExecutionContext, input: any): Promise<ProviderResponse<any>> {
    const attemptContext = ctx.attemptContext ??= createProviderAttemptContext({ correlationId: ctx.correlationId ?? ctx.traceId, executionId: ctx.executionId });
    console.log('[GATEWAY] Entrando no DirectExecutor com input:', { model: input.model, messageCount: input.messages?.length });
    let capability: Capability = input.capability === 'vision' || ctx.complexity?.requiresVision ? 'vision' : 'chat';
    
    let targetModel = input.model || 'auto';
    const originalMessages = input.messages || [];
    let currentMessages = [...originalMessages];

    // An explicitly selected connection is authoritative: validate its
    // provider/capability and never let smart routing silently switch it.
    if (ctx.providerAccountId) {
      const pool = registry.getAccountPool() ?? providerAccountPool;
      const account = await pool.resolveAccount(ctx.providerAccountId);
      if (!account || !account.enabled) throw Object.assign(new Error('Provider account not found or disabled'), { status: 404, code: 'PROVIDER_ACCOUNT_NOT_FOUND' });
      if (input.provider && input.provider !== account.providerName) throw Object.assign(new Error('Provider account does not match provider'), { status: 400, code: 'PROVIDER_ACCOUNT_MISMATCH' });
      if (!account.provider.capabilities.includes(capability)) throw Object.assign(new Error('Provider account does not support this capability'), { status: 400, code: 'CAPABILITY_NOT_SUPPORTED' });
      const { providerAccountId: _providerAccountId, ...providerInput } = input;
      providerInput.model = targetModel === 'auto' ? undefined : targetModel;
      return providerAttemptTracker.observe<ProviderResponse<any>>(attemptContext, { provider: account.providerName, providerAccountId: account.accountId, capability, model: providerInput.model },
        () => capability === 'vision' ? account.provider.vision(providerInput) : account.provider.chat(providerInput));
    }
    
    // 1. Tenta roteamento inteligente baseado em capacidades, pools, health e quotas
    try {
      const routeDecision = await smartRouterService.route(input, {
        requestedModel: targetModel,
        routingPolicy: input.routingPolicy || input.routing_policy || ctx.routingPolicy,
      });
      ctx.trace?.push({
        type: 'smart_route_selected',
        timestamp: Date.now(),
        metadata: {
          pool: routeDecision.pool,
          primary: routeDecision.primary.model,
          provider: routeDecision.primary.provider,
          score: routeDecision.primary.score,
          fallbackCount: routeDecision.fallbackChain.length,
        },
      } as any);

      const modelTraits = getModelTraits(routeDecision.primary.model);
      const maxContext = modelTraits.maxContextTokens || 8192;
      const { compressedMessages, compressedSystem } = compressContext(currentMessages, maxContext, input.system);

      const providerInput = {
        ...input,
        messages: compressedMessages,
        system: compressedSystem,
      };

      const executionResult = await smartRouterService.executeWithSmartFallback(
        providerInput,
        routeDecision,
        {
          tenantId: ctx.tenant,
          projectId: input.projectId,
          attemptContext,
          onCandidateAttempt: (candidate, attempt) => {
            ctx.trace?.push({
              type: 'candidate_attempt',
              timestamp: Date.now(),
              metadata: { provider: candidate.provider, model: candidate.model, attempt },
            } as any);
          },
        },
      );

      ctx.metrics = {
        ...ctx.metrics,
        provider: executionResult.selectedCandidate.provider,
        model: executionResult.selectedCandidate.model,
        retries: executionResult.attempts.length - 1,
      } as any;

      return executionResult.result;
    } catch (smartError: any) {
      if (registry.getAccountPool() && !isTransientProviderFailure(smartError)) throw smartError;
      const safeError = safeProviderFailure(smartError);
      console.warn('[SMART_ROUTER] Fallback para cascata padrão devido a:', safeError.message);
    }

    // Lista de fallback baseada na ordem configurada
    let cascade = [...fallbackOrder];
    
    // Se o cliente especificou um provedor no modelo, tentamos ele primeiro
    const modelParts = targetModel.split('/');
    if (modelParts.length > 1 && cascade.includes(modelParts[0])) {
      cascade = [modelParts[0], ...cascade.filter(p => p !== modelParts[0])];
    } else if (targetModel.toLowerCase().includes('claude')) {
      if (!cascade.includes('anthropic')) {
        cascade = ['anthropic', ...cascade];
      } else {
        cascade = ['anthropic', ...cascade.filter(p => p !== 'anthropic')];
      }
    } else if (targetModel.toLowerCase().includes('deepseek') || targetModel.toLowerCase().includes('coder')) {
      if (cascade.includes('ollama')) {
        cascade = ['ollama', ...cascade.filter(p => p !== 'ollama')];
      } else if (cascade.includes('deepseek')) {
        cascade = ['deepseek', ...cascade.filter(p => p !== 'deepseek')];
      }
    } else if (targetModel.toLowerCase().includes('kimi') || targetModel.toLowerCase().includes('moonshot')) {
      if (cascade.includes('kimi')) {
        cascade = ['kimi', ...cascade.filter(p => p !== 'kimi')];
      }
    }
    
    const errors: any[] = [];
    
    for (const providerName of cascade) {
      console.log(`[FALLBACK] Tentando provider: ${providerName}`);
      const accountPool = registry.getAccountPool();
      if (accountPool && await accountPool.hasConfiguredAccounts(providerName)) {
        // A provider with account-backed credentials may be retried only via
        // those instances; never fall through to its legacy environment config.
        continue;
      }
      if (providerCircuit.isOpen(providerName)) {
         ctx.trace?.push({ type: 'circuit_breaker', timestamp: Date.now(), metadata: { providerName } } as any);
         continue; // Provider ignorado porque esta unhealthy
      }
      
      let provider;
      try {
        provider = await registry.resolve(capability, providerName);
      } catch {
        continue;
      }
      
      if (!provider) continue;

      // Fase 1 & Fase 2: Smart Context Manager & Token Manager
      const modelTraits = getModelTraits(targetModel);
      const maxContext = modelTraits.maxContextTokens || 8192;
      
      console.log(`[COMPRESS] Iniciando compressao. Max Context: ${maxContext}`);
      // Comprimir contexto dinamicamente para os limites do provedor atual na cascata
      const { compressedMessages, compressedSystem } = compressContext(currentMessages, maxContext, input.system);
      console.log(`[COMPRESSED] Contexto comprimido. Total msgs: ${compressedMessages.length}`);
      
      // Tratamento de modelos cruzados
      let overrideModel = targetModel;
      const t = targetModel.toLowerCase();
      const isAnthropic = t.includes('claude');
      const isOpenAI = t.includes('gpt');
      
      if (providerName === 'groq' && (isAnthropic || isOpenAI)) {
        overrideModel = 'auto';
      } else if (providerName === 'openai' && isAnthropic) {
        overrideModel = 'auto';
      } else if (providerName === 'anthropic' && isOpenAI) {
        overrideModel = 'auto';
      } else if (providerName === 'ollama') {
        if (isAnthropic || isOpenAI || t === 'auto') {
          overrideModel = (provider as any)?.config?.defaultModel || 'qwen2.5:3b';
        }
      }

      const resolvedModel = overrideModel !== 'auto'
        ? overrideModel
        : ((provider as any)?.config?.defaultModel || (providerName === 'ollama' ? 'qwen2.5:3b' : undefined));

      const providerInput = {
        ...input,
        model: resolvedModel,
        messages: compressedMessages,
        system: compressedSystem
      };

      const start = Date.now();
      
      // Fase 4: Rate Limit Manager (Retry com Exponential Backoff)
      let attempt = 0;
      const maxAttempts = 3;
      let successResponse: ProviderResponse<any> | null = null;
      
      while (attempt < maxAttempts) {
        console.log(`[PROVIDER] Fazendo chamada ao provedor ${providerName} (attempt ${attempt + 1})`);
        try {
          if (capability === 'vision') {
            successResponse = await providerAttemptTracker.observe(attemptContext, { provider: provider.name, capability, model: providerInput.model }, () => provider.vision(providerInput));
          } else {
            successResponse = await providerAttemptTracker.observe(attemptContext, { provider: provider.name, capability, model: providerInput.model }, () => provider.chat(providerInput));
          }
          providerCircuit.recordSuccess(providerName);
          break; // Sucesso!
        } catch (error: any) {
          const status = error?.status || error?.statusCode;
          const msgString = error?.message?.toLowerCase() || '';
          const isRateLimit = status === 429 || msgString.includes('rate limit') || msgString.includes('too many requests');
          const isPayloadTooLarge = status === 413 || msgString.includes('too large') || msgString.includes('maximum context length');
          
          if (isRateLimit) {
             console.log(`[RETRY] Rate limit detectado no provider ${providerName}`);
             attempt++;
             if (attempt >= maxAttempts) {
                providerCircuit.recordFailure(providerName);
                errors.push({ provider: providerName, ...safeProviderFailure(error) });
                break;
             }
             // Backoff exponencial: 1s, 2s, 4s, 8s...
             const retryAfter = error?.headers?.['retry-after'] ? parseInt(error.headers['retry-after']) * 1000 : Math.pow(2, attempt - 1) * 1000;
             ctx.trace?.push({ type: 'rate_limit_retry', timestamp: Date.now(), metadata: { providerName, attempt, retryAfter } } as any);
             await new Promise(r => setTimeout(r, retryAfter));
             continue; // Tenta de novo no mesmo provedor
          }
          
          if (isPayloadTooLarge) {
             console.log(`[RETRY] Payload Too Large detectado no provider ${providerName}. Ajustando limite.`);
             // Reduz o maxContext em 20% e tenta comprimir de novo
             const reducedLimit = Math.floor(maxContext * 0.8);
             const recompressed = compressContext(currentMessages, reducedLimit, input.system);
             providerInput.messages = recompressed.compressedMessages;
             providerInput.system = recompressed.compressedSystem;
             ctx.trace?.push({ type: 'context_compressed', timestamp: Date.now(), metadata: { providerName, reducedLimit } } as any);
             attempt++;
             continue; 
          }
          
          if ((status === 404 || msgString.includes('not found')) && providerName === 'ollama') {
            const fallbackLocal = (provider as any)?.config?.defaultModel || 'qwen2.5:3b';
            if (providerInput.model !== fallbackLocal) {
              console.log(`[RETRY] Modelo ${providerInput.model} não instalado no Ollama. Tentando modelo local disponível: ${fallbackLocal}`);
              providerInput.model = fallbackLocal;
              attempt++;
              continue;
            }
          }
          
          // Outros erros
          providerCircuit.recordFailure(providerName);
          if (registry.getAccountPool() && !isTransientProviderFailure(error)) throw error;
          errors.push({ provider: providerName, ...safeProviderFailure(error) });
          break; // Vai para o proximo fallback provider
        }
      }
      
      if (successResponse) {
        console.log(`[FINISHED] Sucesso com provedor ${providerName}`);
        ctx.metrics = { ...ctx.metrics, provider: providerName, retries: attempt } as any;
        return successResponse;
      }
    }
    
    // Fallback total falhou - tenta LayaProvider como salva-vidas gracioso
    if (registry.has('laya')) {
      try {
        const layaProvider = registry.get('laya');
        const layaRes = await providerAttemptTracker.observe(attemptContext, { provider: layaProvider.name, capability: 'chat', model: input.model }, () => layaProvider.chat(input));
        return layaRes;
      } catch {
        // segue para gatewayError
      }
    }

    ctx.metrics = { ...ctx.metrics, } as any;
    const gatewayError = new ProviderError('gateway', 'All providers in fallback chain failed.', 'ALL_FAILED', 502, false);
    (gatewayError as any).errors = errors;
    throw gatewayError;
  }
}

export class QueueExecutor implements Executor {
  async execute(ctx: ExecutionContext, input: any): Promise<ProviderResponse<any>> {
    const start = Date.now();
    let queueName: 'vision' | 'text' | 'chat' | 'mission' = 'text';
    if (ctx.complexity?.requiresVision) queueName = 'vision';
    
    try {
      const { jobId, result } = await enqueueAndWait(queueName as any, {
        ...input,
        stream: false, 
        execution: { traceId: ctx.traceId, executionId: ctx.executionId }
      }, {
        tenantId: ctx.tenant,
        scopes: ctx.scopes,
        correlationId: ctx.correlationId,
      });
      const rawResult = result as any;
      
      if (rawResult?.result?.metrics) {
        ctx.metrics = { ...ctx.metrics, ...rawResult.result.metrics };
      }
      if (rawResult?.result?.tracerEvents) {
        ctx.trace = [...(ctx.trace || []), ...rawResult.result.tracerEvents];
      }
      
      ctx.metrics = { ...ctx.metrics, } as any;
      ctx.queueUsed = true;
      ctx.plannerUsed = true; // For WORKFLOW/Queue we assume planner was used in worker
      
      return result as ProviderResponse<any>;
    } catch (error) {
      ctx.metrics = { ...ctx.metrics, } as any;
      throw error;
    }
  }
}

export class ExecutorFactory {
  static getExecutor(transport: ExecutionTransport): Executor {
    return transport === ExecutionTransport.DIRECT 
      ? new DirectExecutor() 
      : new QueueExecutor();
  }
}

export class ResponseComposer {
  static compose(ctx: ExecutionContext, response: ProviderResponse<any>): ProviderResponse<any> {
    // In the future this handles multi-provider response assembly.
    // For now, it acts as a consistent pass-through and metrics decorator.
    
    if (!('stream' in response) || !response.stream) {
      const syncResponse = response as any;
      if (!syncResponse.tokens) {
         syncResponse.tokens = { prompt: 0, completion: 0, total: 0 };
      }
      const metadata = ctx.metadata as any;
      syncResponse.adaptive = {
        taskType: metadata?.classification?.taskType,
        complexityScore: metadata?.classification?.complexityScore,
        confidenceScore: metadata?.classification?.confidenceScore,
        strategy: metadata?.strategy?.selected,
        requestedMode: metadata?.strategy?.requestedMode,
        maxAgents: metadata?.strategy?.maxAgents,
        promptVersion: metadata?.promptOptimization?.promptVersion,
        optimizerVersion: metadata?.promptOptimization?.optimizerVersion,
        applied: metadata?.promptOptimization?.applied === true,
        system1: metadata?.system1Decision,
        decision: metadata?.system1Decision?.decision,
      };
    }
    
    return response;
  }
}

export class ExecutionGateway {
  static async execute(tenant: string, payload: any, forceStream: boolean = false, auth: { scopes?: string[] } = {}): Promise<{ ctx: ExecutionContext, response: ProviderResponse<any> }> {
    const traceId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    
    const messages = payload.messages || [];
    const model = payload.model || 'auto';
    const stream = payload.stream === true || forceStream;
    const providerAccountId = payload.providerAccountId;
    if (providerAccountId) {
      const requiredScopes = payload.capability === 'vision' || (Array.isArray(payload.images) && payload.images.length > 0) ? ['vision'] : ['chat', 'text'];
      if (!auth.scopes || (!auth.scopes.includes('*') && !requiredScopes.some((scope) => auth.scopes!.includes(scope)))) {
        throw Object.assign(new Error('API key lacks permission for provider inference'), { status: 403, code: 'INSUFFICIENT_SCOPE' });
      }
      const account = await (registry.getAccountPool() ?? providerAccountPool).resolveAccount(providerAccountId);
      if (!account || !account.enabled) throw Object.assign(new Error('Provider account not found or disabled'), { status: 404, code: 'PROVIDER_ACCOUNT_NOT_FOUND' });
      if (payload.provider && payload.provider !== account.providerName) throw Object.assign(new Error('Provider account does not match provider'), { status: 400, code: 'PROVIDER_ACCOUNT_MISMATCH' });
      payload.provider = account.providerName;
    }
    
    // Injetar ferramentas da APILayer
    payload.tools = [...(payload.tools || []), ...apiLayerTools];
    
    const tracer = new MemoryExecutionTracer();
    const ctx: ExecutionContext = {
      attemptContext: createProviderAttemptContext({ correlationId: traceId, executionId }),
      executionId,
      traceId,
      correlationId: traceId,
      providerAccountId,
      routingPolicy: payload.routingPolicy || payload.routing_policy,
      scopes: auth.scopes,
      tenant,
      cacheHit: 'MISS',
      plannerUsed: false,
      queueUsed: false,
      metadata: { payload },
      startTime: Date.now()
    };
    
    tracer.attachToContext(ctx);
    tracer.event('start', 'gateway');

    // 1. Semantic Prompt Fingerprint & Cache
    tracer.event('start', 'cache_lookup');
    const cacheKey = cacheService.generateKey({
      model,
      messages,
      prompt: payload.prompt,
      temperature: payload.temperature,
      top_p: payload.top_p,
      tools: payload.tools,
      system: payload.system,
      tenant,
      providerAccountId,
    });
    
    if (!stream) {
      const cached = await cacheService.get(cacheKey);
      if (cached.hit !== 'MISS' && cached.data) {
        ctx.cacheHit = cached.hit;
        ctx.decision = { mode: ExecutionMode.FAST, transport: ExecutionTransport.DIRECT, stream: false, reason: 'CACHE_HIT' };
        tracer.event('finish', 'cache_lookup', { hit: cached.hit });
        tracer.event('finish', 'gateway');
        return { ctx, response: ResponseComposer.compose(ctx, cached.data as ProviderResponse<any>) };
      }
    }
    tracer.event('finish', 'cache_lookup', { hit: 'MISS' });
    
    // 2. Fast Intent Classifier & System 1 Semantic Decision (<35ms)
    const decisionStart = Date.now();
    tracer.event('start', 'intent_classifier');
    const userPrompt = typeof payload.prompt === 'string' ? payload.prompt : messages.filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n');
    
    let layaDecision: any;
    try {
      const laya = new LayaProvider();
      const layaResult = await providerAttemptTracker.observe(ctx.attemptContext!, { provider: laya.name, capability: 'decision' }, () => laya.decision({ prompt: userPrompt, messages }));
      layaDecision = layaResult.result;
    } catch {
      // fallback gracioso
    }

    const intent = FastIntentClassifier.classify(messages, { tools: payload.tools, prompt: userPrompt });
    let mode = intent.mode;
    tracer.event('finish', 'intent_classifier', { mode, confidence: intent.confidence });
    const classification = TaskClassifier.classify(messages, { tools: payload.tools });
    const decisionLatencyMs = Math.max(1, Date.now() - decisionStart);

    const isCoding = layaDecision?.decision === 'coding' || intent.isCoding || false;
    const isComplex = layaDecision?.decision === 'workflow' || intent.isComplexProject || false;
    const isFast = layaDecision?.decision === 'fast' || intent.mode === ExecutionMode.FAST || false;

    const system1Decision = {
      decision: isComplex ? 'workflow' : isCoding ? 'coding' : (isFast ? 'fast' : 'standard'),
      selectedModel: layaDecision?.selectedModel || intent.recommendedModel || (isCoding ? 'deepseek-coder:6.7b' : 'qwen2.5:3b'),
      selectedProvider: layaDecision?.selectedProvider || 'ollama',
      fastResponse: layaDecision?.fastResponse || (isCoding ? 'Identifiquei uma tarefa de código/desenvolvimento. Ativando especialista em código.' : undefined),
      latencyMs: decisionLatencyMs,
      isCoding,
      isComplexProject: isComplex,
    };

    const requestedModel = (model || '').toLowerCase().trim();
    if (['laya', 'decision', 'laya-system1'].includes(requestedModel) && !payload.forceCascade) {
      const fastText =
        system1Decision.fastResponse ||
        `[LAYA System 1]: Decisão tomada em ${system1Decision.latencyMs}ms. Encaminhando para ${system1Decision.selectedModel} (${system1Decision.decision}).`;
      ctx.decision = { mode: ExecutionMode.FAST, transport: ExecutionTransport.DIRECT, stream: false, reason: 'SYSTEM_1_FAST_DECISION' };
      const response = {
        result: { message: { role: 'assistant', content: fastText }, text: fastText },
        model: 'laya-system1',
        provider: 'laya',
        tokens: { prompt: Math.ceil(userPrompt.length / 4), completion: 15, total: Math.ceil(userPrompt.length / 4) + 15 },
        executionTime: decisionLatencyMs,
        cached: false,
      };
      tracer.event('finish', 'gateway');
      return { ctx, response: ResponseComposer.compose(ctx, response as any) };
    }

    let effectiveModel = payload.model;
    let effectivePool = payload.pool;
    if (['auto', 'laya', 'decision', 'coding', 'fast', ''].includes(requestedModel)) {
      if (isCoding) {
        effectiveModel = intent.recommendedModel || 'deepseek-coder:6.7b';
        effectivePool = 'CODING';
      } else if (isComplex) {
        effectiveModel = 'claude-3-5-sonnet-latest';
        effectivePool = 'POWER';
      } else if (isFast) {
        effectiveModel = 'qwen2.5:1.5b';
        effectivePool = 'FAST';
      }
    }

    const requestedMode = payload.execution_mode || payload.executionMode || 'adaptive';
    const strategy = requestedMode === 'single'
      ? 'single'
      : requestedMode === 'parallel' || requestedMode === 'ensemble'
        ? requestedMode
        : classification.complexityScore <= 30
          ? 'single'
          : classification.complexityScore <= 60
            ? 'single_with_refinement'
            : classification.complexityScore <= 80
              ? 'bounded_parallel'
              : 'ensemble_with_judge';
    const optimization = PromptOptimizer.optimize({
      originalPrompt: userPrompt,
      context: typeof payload.context === 'string' ? payload.context : undefined,
      taskType: classification.taskType,
      constraints: Array.isArray(payload.constraints) ? payload.constraints : undefined,
    });
    const adaptive = payload.execution_mode === 'adaptive' || payload.executionMode === 'adaptive' || payload.execution_mode === undefined;
    const executionPayload = {
      ...(adaptive && optimization.originalPrompt
        ? {
            ...payload,
            prompt: typeof payload.prompt === 'string' ? optimization.optimizedPrompt : payload.prompt,
            messages: messages.map((message: any, index: number) => {
              const isLastUser = message.role === 'user' && index === messages.map((m: any) => m.role).lastIndexOf('user');
              return isLastUser && typeof message.content === 'string'
                ? { ...message, content: optimization.optimizedPrompt }
                : message;
            }),
          }
        : payload),
      model: effectiveModel,
      pool: effectivePool,
    };
    ctx.metadata = {
      ...ctx.metadata,
      system1Decision,
      classification,
      strategy: { requestedMode, selected: strategy, maxAgents: classification.estimatedAgents },
      promptOptimization: {
        promptVersion: optimization.promptVersion,
        optimizerVersion: optimization.optimizerVersion,
        estimatedTokens: optimization.estimatedTokens,
        applied: adaptive && Boolean(optimization.originalPrompt),
        originalPrompt: optimization.originalPrompt,
        optimizedPrompt: optimization.optimizedPrompt,
      },
    };
    
    // Fast Response + Background Intelligence (Dual-Lane Assíncrono)
    const isExplicitAsync = payload.background === true || payload.async === true || (payload.dualLane === true && payload.wait === false);
    if ((isExplicitAsync || (BackgroundOrchestratorService.shouldTriggerBackground(payload, classification.complexityScore) && payload.wait === false)) && !stream) {
      const bg = await BackgroundOrchestratorService.executeFastAndBackground({
        prompt: userPrompt,
        messages: executionPayload.messages,
        tenantId: tenant,
        projectId: payload.projectId,
        providerAccountId,
        scopes: auth.scopes,
        correlationId: ctx.correlationId,
      });
      ctx.decision = { mode: ExecutionMode.FAST, transport: ExecutionTransport.DIRECT, stream: false, reason: 'DUAL_LANE_BACKGROUND_TRIGGERED' };
      const response = {
        result: { text: bg.fastResponse, missionId: bg.missionId, status: bg.status, streamUrl: bg.streamUrl },
        model: 'fast-router',
        provider: 'orchestrator',
        tokens: { prompt: Math.ceil(userPrompt.length / 4), completion: 35, total: Math.ceil(userPrompt.length / 4) + 35 },
        executionTime: Date.now() - (ctx.startTime || Date.now()),
        cached: false,
      };
      tracer.event('finish', 'gateway');
      return { ctx, response: ResponseComposer.compose(ctx, response as any) };
    }

    // 3. Complexity (only if WORKFLOW)
    if (mode === ExecutionMode.WORKFLOW) {
      tracer.event('start', 'complexity_analyzer');
      ctx.complexity = ComplexityAnalyzer.analyze(messages, model, { stream, tools: payload.tools });
      tracer.event('finish', 'complexity_analyzer');
    }
    
    ctx.decision = { mode, transport: ExecutionTransport.DIRECT, stream, reason: `Confidence: ${intent.confidence}` };
    
    // 4. Dispatch Policy
    tracer.event('start', 'dispatcher');
    ctx.dispatch = ExecutionDispatcher.dispatch(executionPayload, ctx);
    tracer.event('finish', 'dispatcher', { transport: ctx.dispatch.transport });
    
    // Update transport based on dispatch policy
    ctx.decision.transport = ctx.dispatch.transport;
    
    // 5. Execution
    tracer.event('start', 'executor', { transport: ctx.decision.transport });
    const executor = ExecutorFactory.getExecutor(ctx.decision.transport);
    let rawResponse = await executor.execute(ctx, executionPayload);
    tracer.event('finish', 'executor');

    // Refinement is opt-in because it performs additional provider calls. Keep
    // the default adaptive path fast while allowing callers to request a
    // bounded quality pass with explicit controls.
    const requestedRefinements = Number(payload.max_refinements ?? 0);
    if (!stream && requestedRefinements > 0 && rawResponse && !('stream' in rawResponse)) {
      const refinement = await refineResponse(
        userPrompt,
        optimization.optimizedPrompt,
        rawResponse,
        async (prompt) => executor.execute(ctx, { ...executionPayload, prompt }),
        {
          maxRefinements: requestedRefinements,
          qualityThreshold: payload.quality_threshold,
          budgetTokens: payload.budget,
        },
      );
      rawResponse = refinement.response as typeof rawResponse;
      ctx.metadata = {
        ...ctx.metadata,
        refinement: {
          refinements: refinement.refinements,
          qualityScore: refinement.qualityScore,
          stoppedReason: refinement.stoppedReason,
        },
      };
    }
    
    // Intercept Tool Calls from APILayer
    if (!stream && rawResponse && !('stream' in rawResponse) && rawResponse.result?.toolCalls && rawResponse.result.toolCalls.length > 0) {
      const toolCalls = rawResponse.result.toolCalls;
      const apiLayerToolCalls = toolCalls.filter((tc: any) => apiLayerTools.find(t => t.function.name === tc.name));
      
      if (apiLayerToolCalls.length > 0) {
        console.log('[GATEWAY] Interceptando chamada de ferramenta da APILayer:', apiLayerToolCalls.map((t: any) => t.name));
        
        const newMessages = [...executionPayload.messages];
        // Append assistant's tool calls
        newMessages.push({ 
          role: 'assistant', 
          content: rawResponse.result.message?.content || null, 
          tool_calls: toolCalls 
        });
        
        for (const tc of apiLayerToolCalls) {
          const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
          const result = await APILayerRegistry.executeTool(tc.name, args);
          newMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        
        // Execute again with tool results
        const followupPayload = { ...executionPayload, messages: newMessages };
        const followupResponse = await executor.execute(ctx, followupPayload);
        
        tracer.startComposer();
        const response = ResponseComposer.compose(ctx, followupResponse);
        tracer.finishComposer();
        return { ctx, response };
      }
    }
    
    // 5. Compose (com suporte a consolidação Dual-Lane / Cascata transparente)
    if ((payload.dualLane === true || payload.cascade === true) && system1Decision.fastResponse && !stream && rawResponse && !('stream' in rawResponse)) {
      const rawRes = rawResponse as any;
      const baseContent = rawRes.result?.message?.content || rawRes.result?.text || '';
      const consolidatedContent = `/* ${system1Decision.fastResponse} */\n\n${baseContent}`;
      if (rawRes.result?.message) {
        rawRes.result.message.content = consolidatedContent;
      }
      if (rawRes.result?.text) {
        rawRes.result.text = consolidatedContent;
      }
      ctx.metadata = {
        ...ctx.metadata,
        system1Decision: {
          ...system1Decision,
          consolidated: true,
          originalFastResponse: system1Decision.fastResponse,
        },
      };
    }

    tracer.startComposer();
    const response = ResponseComposer.compose(ctx, rawResponse);
    tracer.finishComposer();
    
    // 6. Save to Cache
    if (!stream && response && !('stream' in response)) {
      await cacheService.set(cacheKey, response);
    }
    
    if (ctx.metrics) {
      ctx.metrics.totalLatency = Date.now() - (ctx.startTime || Date.now());
      ctx.metrics.cacheHit = ctx.cacheHit !== 'MISS';
    }
    // Learn only from successful, completed executions. The memory service hashes
    // request context and stores aggregate route statistics, never the prompt text.
    if (!stream && response && !('stream' in response)) {
      const routeProvider = String((response as any).provider || (ctx.metrics as any)?.provider || 'unknown');
      const routeModel = String((response as any).model || model || 'auto');
      const totalTokens = Number((response as any).tokens?.total || 0);
      void rememberExecutionSuccess(
        'chat',
        { messages, taskType: classification.taskType, strategy: payload.strategy || 'adaptive', model },
        { provider: routeProvider, model: routeModel },
        // Until a judge is requested, a successful provider response is a neutral
        // quality observation; it must not be recorded as a perfect score.
        Number(payload.quality_threshold != null ? payload.quality_threshold : 50),
        Number(ctx.metrics?.totalLatency || Date.now() - (ctx.startTime || Date.now())),
        tenant,
        payload.projectId,
      ).catch(() => undefined);
      ctx.metadata = { ...ctx.metadata, learning: { recorded: true, tokens: totalTokens } };
    }
    tracer.event('finish', 'gateway');
    
    return { ctx, response };
  }
}



