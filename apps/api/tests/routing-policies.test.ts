import { describe, expect, it } from 'vitest';
import {
  SmartModelRouter,
  RoutingPolicy,
  ModelCapabilityRegistry,
  ProviderRegistry,
  ProviderAccountPool,
  AIProvider,
} from '@api-platform/shared';

describe('Smart Router Multi-Policy Engine (6 Policies)', () => {
  const localModel = ModelCapabilityRegistry.getModel('qwen2.5:1.5b')!;
  const cloudFreeModel = ModelCapabilityRegistry.getModel('llama-3.3-70b-versatile')!;
  const cloudPaidModel = ModelCapabilityRegistry.getModel('gpt-4o')!;

  describe('calculateScore across all 6 policies', () => {
    it('LOCAL_FIRST grants highest bonus to local models', () => {
      const localScore = SmartModelRouter.calculateScore({
        modelInfo: localModel,
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 150,
        isLocal: true,
        policy: 'LOCAL_FIRST',
      });

      const cloudScore = SmartModelRouter.calculateScore({
        modelInfo: cloudFreeModel,
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 150,
        isLocal: false,
        policy: 'LOCAL_FIRST',
      });

      expect(localScore).toBeGreaterThan(cloudScore);
      expect(localScore).toBeGreaterThanOrEqual(95);
    });

    it('ACCOUNT_FIRST prioritizes connected accounts (OAuth / connected account)', () => {
      const accountOAuthScore = SmartModelRouter.calculateScore({
        modelInfo: cloudPaidModel,
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 300,
        isLocal: false,
        policy: 'ACCOUNT_FIRST',
        isAccount: true,
        authMode: 'oauth',
      });

      const rawApiKeyScore = SmartModelRouter.calculateScore({
        modelInfo: cloudPaidModel,
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 300,
        isLocal: false,
        policy: 'ACCOUNT_FIRST',
        isAccount: false,
        authMode: 'apiKey',
      });

      expect(accountOAuthScore).toBeGreaterThan(rawApiKeyScore);
      expect(accountOAuthScore - rawApiKeyScore).toBeGreaterThanOrEqual(30);
    });

    it('API_FIRST prioritizes direct API keys over oauth accounts', () => {
      const apiKeyScore = SmartModelRouter.calculateScore({
        modelInfo: cloudPaidModel,
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 300,
        isLocal: false,
        policy: 'API_FIRST',
        isAccount: false,
        authMode: 'apiKey',
      });

      const oauthScore = SmartModelRouter.calculateScore({
        modelInfo: cloudPaidModel,
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 300,
        isLocal: false,
        policy: 'API_FIRST',
        isAccount: true,
        authMode: 'oauth',
      });

      expect(apiKeyScore).toBeGreaterThan(oauthScore);
    });

    it('COST_OPTIMIZED prioritizes local and free-tier models over paid tiers', () => {
      const freeTierScore = SmartModelRouter.calculateScore({
        modelInfo: cloudFreeModel, // Free tier
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 300,
        isLocal: false,
        policy: 'COST_OPTIMIZED',
      });

      const paidTierScore = SmartModelRouter.calculateScore({
        modelInfo: cloudPaidModel, // Paid tier
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 300,
        isLocal: false,
        policy: 'COST_OPTIMIZED',
      });

      expect(freeTierScore).toBeGreaterThan(paidTierScore);
    });

    it('LOW_LATENCY prioritizes instant and sub-300ms responses', () => {
      const instantScore = SmartModelRouter.calculateScore({
        modelInfo: cloudFreeModel,
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 120, // Fast
        isLocal: false,
        policy: 'LOW_LATENCY',
      });

      const slowScore = SmartModelRouter.calculateScore({
        modelInfo: cloudFreeModel,
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 2800, // Slow
        isLocal: false,
        policy: 'LOW_LATENCY',
      });

      expect(instantScore).toBeGreaterThan(slowScore);
      expect(instantScore - slowScore).toBeGreaterThanOrEqual(30);
    });

    it('AUTO balances health, quota, and operational tiers sensibly', () => {
      const autoScore = SmartModelRouter.calculateScore({
        modelInfo: localModel,
        requiredCaps: ['chat'],
        isHealthy: true,
        hasActiveKey: true,
        quotaAvailable: true,
        quotaUtilization: 0,
        latencyMs: 200,
        isLocal: true,
        policy: 'AUTO',
      });

      expect(autoScore).toBeGreaterThanOrEqual(70);
    });
  });

  describe('resolveRoute with routing policies and candidate accounts', () => {
    it('returns the chosen routingPolicy in RouteDecision', async () => {
      const router = new SmartModelRouter();
      const decision = await router.resolveRoute(
        { prompt: 'Olá, teste de rota' },
        { routingPolicy: 'LOW_LATENCY' },
      );

      expect(decision.routingPolicy).toBe('LOW_LATENCY');
      expect(decision.primary).toBeDefined();
      expect(decision.primary.score).toBeGreaterThan(0);
      expect(Array.isArray(decision.fallbackChain)).toBe(true);
    });

    it('selects candidate account when ACCOUNT_FIRST policy is specified', async () => {
      const mockProvider: AIProvider = {
        name: 'gemini',
        type: 'vlm',
        capabilities: ['chat', 'vision'],
        chat: async () => ({ id: '1', provider: 'gemini', model: 'gemini-2.0-flash', text: 'ok' }),
        vision: async () => ({ id: '1', provider: 'gemini', model: 'gemini-2.0-flash', text: 'ok' }),
        generateText: async () => ({ id: '1', provider: 'gemini', model: 'gemini-2.0-flash', text: 'ok' }),
        health: async () => ({ ok: true, latencyMs: 150 }),
      };

      const registry = new ProviderRegistry();
      registry.register(mockProvider);

      const pool = new ProviderAccountPool(
        async () => [
          {
            accountId: 'acc-gemini-oauth-1',
            providerName: 'gemini',
            provider: mockProvider,
            enabled: true,
            configured: true,
            healthOk: true,
            healthCheckedAt: new Date(),
            healthLatencyMs: 120,
            authMode: 'oauth',
          },
        ],
        async () => 0,
      );
      registry.setAccountPool(pool);

      const router = new SmartModelRouter(registry);
      const decision = await router.resolveRoute(
        { prompt: 'Análise de dados' },
        { routingPolicy: 'ACCOUNT_FIRST' },
      );

      expect(decision.routingPolicy).toBe('ACCOUNT_FIRST');
      expect(decision.primary.providerAccountId).toBe('acc-gemini-oauth-1');
      expect(decision.primary.isAccount).toBe(true);
      expect(decision.primary.authMode).toBe('oauth');
    });

    it('selects local provider when LOCAL_FIRST policy is specified', async () => {
      const router = new SmartModelRouter();
      const decision = await router.resolveRoute(
        { prompt: 'Gere um pequeno resumo' },
        { routingPolicy: 'LOCAL_FIRST' },
      );

      expect(decision.routingPolicy).toBe('LOCAL_FIRST');
      expect(decision.primary.provider).toBe('ollama');
    });
  });
});
