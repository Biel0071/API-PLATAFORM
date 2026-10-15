import { describe, expect, it } from 'vitest';
import {
  ModelCapabilityRegistry,
  ProviderKeyManager,
  ProviderQuotaManager,
  SmartModelRouter,
  ModelCapabilityInfo,
} from '@api-platform/shared';
import { BackgroundOrchestratorService } from '../src/services/background-orchestrator.service';
import { missionsService } from '../src/services/missions.service';
import { eventBus } from '../src/services/event-bus.service';

describe('Smart Model Router, Pools & Multi-Provider Architecture', () => {
  describe('ModelCapabilityRegistry & Pools', () => {
    it('lists registered models and contains verified models', () => {
      const models = ModelCapabilityRegistry.listModels();
      expect(models.length).toBeGreaterThan(0);

      // Verify presence of verified local and free-tier models
      const localQwen = ModelCapabilityRegistry.getModel('ollama:qwen2.5:1.5b');
      expect(localQwen).toBeDefined();
      expect(localQwen?.provider).toBe('ollama');
      expect(localQwen?.capabilities).toContain('chat');
      expect(localQwen?.capabilities).toContain('fast_response');

      const groqLlama = ModelCapabilityRegistry.getModel('groq:llama-3.3-70b-versatile');
      expect(groqLlama).toBeDefined();
      expect(groqLlama?.provider).toBe('groq');
      expect(groqLlama?.pools).toContain('POWER');
    });

    it('resolves virtual model aliases to logical pools', () => {
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('fast')).toBe('FAST');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('rapido')).toBe('FAST');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('coding')).toBe('CODING');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('coder')).toBe('CODING');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('reasoning')).toBe('REASONING');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('vision')).toBe('VISION');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('power')).toBe('POWER');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('unknown')).toBe('AUTO');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias(undefined)).toBe('AUTO');
    });

    it('filters models strictly by required capabilities', () => {
      const visionModels = ModelCapabilityRegistry.filterByCapabilities(['vision']);
      expect(visionModels.length).toBeGreaterThan(0);
      for (const m of visionModels) {
        expect(m.capabilities).toContain('vision');
      }

      // Ensure models without vision are excluded
      const textOnly = visionModels.find((m) => m.id === 'qwen2.5:0.5b');
      expect(textOnly).toBeUndefined();

      // Ensure qwen3.5:0.8b (which failed VPS color vision smoke test) does not have vision
      const qwen35 = ModelCapabilityRegistry.getModel('ollama:qwen3.5:0.8b');
      expect(qwen35?.capabilities).not.toContain('vision');
    });

    it('retrieves models by pool', () => {
      const fastModels = ModelCapabilityRegistry.getModelsForPool('FAST');
      expect(fastModels.length).toBeGreaterThan(0);
      for (const m of fastModels) {
        expect(m.pools).toContain('FAST');
      }

      const codingModels = ModelCapabilityRegistry.getModelsForPool('CODING');
      expect(codingModels.length).toBeGreaterThan(0);
      for (const m of codingModels) {
        expect(m.pools).toContain('CODING');
      }
    });
  });

  describe('ProviderKeyManager', () => {
    it('masks keys securely and never exposes full raw keys in status', () => {
      const masked1 = ProviderKeyManager.maskKey('gsk_abcdef1234567890xyz_secret_test_key_long');
      expect(masked1).toContain('****');
      expect(masked1).not.toContain('secret_test_key');

      ProviderKeyManager.clear();
      ProviderKeyManager.registerKey('groq', 'gsk_abcdef1234567890xyz_secret_test_key_long');
      ProviderKeyManager.registerKey('openrouter', 'sk-or-v1-abcdef1234567890mnopqrstuvwxyz123456');

      const reports = ProviderKeyManager.listReport();
      expect(reports.length).toBe(2);

      for (const r of reports) {
        expect(r.maskedKey).toContain('****');
        expect(r.maskedKey).not.toContain('secret_test_key');
        expect(r.maskedKey).not.toContain('mnopqrstuvwxyz');
      }
    });

    it('retrieves active keys and tracks success and error metrics', () => {
      ProviderKeyManager.clear();
      const k1 = ProviderKeyManager.registerKey('groq', 'gsk_active_primary_key_001');

      const active = ProviderKeyManager.getActiveKey('groq');
      expect(active).toBeDefined();
      expect(active?.rawKey).toBe('gsk_active_primary_key_001');

      // Record success with latency and tokens
      ProviderKeyManager.recordSuccess(k1.id, 250, { prompt: 50, completion: 75 });
      const reportAfterSuccess = ProviderKeyManager.listReport('groq')[0];
      expect(reportAfterSuccess.requests).toBe(1);
      expect(reportAfterSuccess.tokens.total).toBe(125);
      expect(reportAfterSuccess.latencyMs).toBe(250);
    });

    it('applies exponential cooldown backoff on 429 rate limit', () => {
      ProviderKeyManager.clear();
      const key1 = ProviderKeyManager.registerKey('groq', 'key-1-rate-limited-test');
      const key2 = ProviderKeyManager.registerKey('groq', 'key-2-backup-test');

      // Simulate 429 on key 1
      ProviderKeyManager.recordError(key1.id, 429, 'Rate limit exceeded');

      const reportKey1 = ProviderKeyManager.listReport('groq').find((k) => k.id === key1.id);
      expect(reportKey1?.status).toBe('cooldown');
      expect(reportKey1?.cooldownReason).toContain('Rate Limit');

      // Active key should now automatically be Key 2
      const active = ProviderKeyManager.getActiveKey('groq');
      expect(active?.id).toBe(key2.id);
    });
  });

  describe('ProviderQuotaManager', () => {
    it('tracks requests and enforces RPM/RPD limits', () => {
      ProviderQuotaManager.setLimits('custom-provider', {
        maxRequestsPerMinute: 2,
        maxRequestsPerDay: 10,
        maxTokensPerMinute: 1000,
        maxTokensPerDay: 5000,
      });

      // 1st request - allowed
      const check1 = ProviderQuotaManager.checkAvailability('custom-provider');
      expect(check1.available).toBe(true);
      ProviderQuotaManager.recordUsage('custom-provider', { total: 100 });

      // 2nd request - allowed
      const check2 = ProviderQuotaManager.checkAvailability('custom-provider');
      expect(check2.available).toBe(true);
      ProviderQuotaManager.recordUsage('custom-provider', { total: 100 });

      // 3rd request in same minute - rejected due to RPM limit
      const check3 = ProviderQuotaManager.checkAvailability('custom-provider');
      expect(check3.available).toBe(false);
      expect(check3.reason).toContain('Limite de requisições por minuto atingido');
    });

    it('returns quota status report for operational capacity projection', () => {
      ProviderQuotaManager.recordUsage('groq', { prompt: 200, completion: 300 });

      const status = ProviderQuotaManager.getStatus('groq');
      expect(status).toBeDefined();
      expect(status.provider).toBe('groq');
      expect(status.requestsThisMinute).toBeGreaterThanOrEqual(1);
      expect(status.tokensToday).toBeGreaterThanOrEqual(500);
      expect(status.isAvailable).toBe(true);
    });
  });

  describe('SmartModelRouter', () => {
    it('infers task capabilities and complexity accurately', () => {
      // Coding task inference
      const codingCaps = SmartModelRouter.inferRequiredCapabilities({
        prompt: 'Escreva uma função TypeScript com interface para validar tokens JWT',
      });
      expect(codingCaps).toContain('coding');

      // Vision task inference
      const visionCaps = SmartModelRouter.inferRequiredCapabilities({
        prompt: 'Analise este screenshot da dashboard e aponte os erros de layout',
        images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='],
      });
      expect(visionCaps).toContain('vision');

      // Reasoning task inference
      const reasoningCaps = SmartModelRouter.inferRequiredCapabilities({
        prompt: 'Explique passo a passo o raciocínio e deduza a prova matemática do teorema',
      });
      expect(reasoningCaps).toContain('reasoning');

      // Complexity estimation
      const { score, taskType } = SmartModelRouter.estimateComplexity(
        { prompt: 'Planejamento e arquitetura do pipeline multi-agent' },
        ['reasoning'],
      );
      expect(score).toBeGreaterThanOrEqual(60);
      expect(['mission', 'reasoning']).toContain(taskType);
    });

    it('calculates operational score and strictly preserves capabilities (score = 0 if missing mandatory capability)', () => {
      const visionModel: ModelCapabilityInfo = {
        id: 'gemini-2.5-flash',
        provider: 'gemini',
        pools: ['FAST', 'VISION'],
        capabilities: ['chat', 'vision', 'fast_response'],
        contextWindow: 1048576,
        latencyTier: 'low',
        pricingTier: 'free',
        status: 'available',
      };

      const textModel: ModelCapabilityInfo = {
        id: 'qwen2.5:0.5b',
        provider: 'ollama',
        pools: ['FAST'],
        capabilities: ['chat', 'fast_response'],
        contextWindow: 4096,
        latencyTier: 'instant',
        pricingTier: 'free',
        status: 'available',
      };

      // When vision is required:
      const scoreVisionModel = SmartModelRouter.calculateScore({
        modelInfo: visionModel,
        requiredCaps: ['chat', 'vision'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0.1,
        latencyMs: 350,
        isLocal: false,
      });
      expect(scoreVisionModel).toBeGreaterThan(50);

      // Model without vision MUST get score 0 when vision is mandatory
      const scoreTextModel = SmartModelRouter.calculateScore({
        modelInfo: textModel,
        requiredCaps: ['chat', 'vision'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 50,
        isLocal: true,
      });
      expect(scoreTextModel).toBe(0);
    });

    it('resolves route with strict capability preservation in fallback chain', async () => {
      const router = new SmartModelRouter();
      const decision = await router.resolveRoute({
        prompt: 'Descreva os detalhes desta imagem',
        images: ['data:image/png;base64,abc'],
      });

      expect(decision.requiredCapabilities).toContain('vision');
      expect(decision.pool).toBe('VISION');
      expect(decision.primary.capabilities).toContain('vision');

      // Every candidate in fallback chain MUST have vision capability
      for (const fallback of decision.fallbackChain) {
        expect(fallback.capabilities).toContain('vision');
      }
    });

    it('prioritizes local models first when capabilities and health match', async () => {
      const router = new SmartModelRouter();
      const decision = await router.resolveRoute({
        prompt: 'Olá, qual a capital do Brasil?',
        pool: 'FAST',
      });

      expect(decision.primary).toBeDefined();
      // Should prefer local Ollama model for fast general chat
      expect(decision.primary.provider).toBe('ollama');
    });
  });

  describe('Fast Lane + Background Orchestration Dual-Lane Execution', () => {
    it('provides instant fast response and kicks off background mission with multi-agent stages', async () => {
      const eventSpy: any[] = [];
      const listener = (evt: any) => {
        eventSpy.push(evt);
      };
      eventBus.on('event:agent:thinking', listener);

      const result = await BackgroundOrchestratorService.executeFastAndBackground({
        prompt: 'Planeje e refatore a arquitetura de persistência multi-tenant',
        tenantId: 'tenant-test-01',
        projectId: 'proj-fenix-01',
      });

      expect(result.fastResponse).toContain('Identifiquei uma tarefa de alta complexidade');
      expect(result.status).toBe('acknowledged_background_processing');
      expect(result.streamUrl).toContain('proj-fenix-01');
      expect(result.estimatedAgents).toBe(4);

      // Verify mission was created in MissionsService
      const mission = missionsService.getMission(result.missionId);
      expect(mission).toBeDefined();
      expect(mission?.title).toContain('Planeje e refatore');

      // Give background execution microtasks a brief cycle
      await new Promise((r) => setTimeout(r, 100));

      eventBus.removeListener('event:agent:thinking', listener);
    });
  });
});
