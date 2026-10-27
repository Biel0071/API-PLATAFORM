import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import {
  LayaProvider,
  JevProvider,
  ModelCapabilityRegistry,
  CAPABILITY_REGISTRY,
  MODEL_REGISTRY,
} from '@api-platform/shared';

describe('System 1 Decision Engine & Transparent Cascade', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    adminToken = app.jwt.sign({
      sub: 'admin_test_user',
      email: 'admin@platform.local',
      role: 'admin',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Contracts & Catalog Integrations', () => {
    it('CAPABILITY_REGISTRY registers DECISION with correct permissions', () => {
      const decisionCap = CAPABILITY_REGISTRY.DECISION;
      expect(decisionCap).toBeDefined();
      expect(decisionCap.id).toBe('DECISION');
      expect(decisionCap.permissions).toContain('capability:decision:execute');
      expect(decisionCap.supportsFallback).toBe(true);
    });

    it('MODEL_REGISTRY includes System 1 and System 2 models', () => {
      const layaModel = MODEL_REGISTRY.find((m) => m.id === 'laya-system1');
      expect(layaModel).toBeDefined();
      expect(layaModel?.provider).toBe('laya');
      expect(layaModel?.capability).toBe('DECISION');

      const coderModel = MODEL_REGISTRY.find((m) => m.id === 'deepseek-coder:6.7b');
      expect(coderModel).toBeDefined();
      expect(coderModel?.capability).toBe('CODE');

      const kimiModel = MODEL_REGISTRY.find((m) => m.id === 'moonshot-v1-8k');
      expect(kimiModel).toBeDefined();
      expect(kimiModel?.capability).toBe('CODE');
    });

    it('ModelCapabilityRegistry resolves DECISION pool aliases correctly', () => {
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('decision')).toBe('DECISION');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('decide')).toBe('DECISION');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('laya')).toBe('DECISION');
      expect(ModelCapabilityRegistry.resolvePoolFromAlias('jev')).toBe('DECISION');
      expect(ModelCapabilityRegistry.resolveModelAlias('gemma')).toBe('gemma3:1b');
      expect(ModelCapabilityRegistry.resolveModelAlias('claude-open')).toBe('qwen2.5-coder:1.5b');
      expect(ModelCapabilityRegistry.resolveModelAlias('jev-coder')).toBe('qwen2.5-coder:1.5b');
      expect(ModelCapabilityRegistry.resolveModelAlias('chatgpt-open')).toBe('llama3.2:1b');
      expect(ModelCapabilityRegistry.resolveModelAlias('r1-open')).toBe('deepseek-r1:1.5b');
      expect(ModelCapabilityRegistry.resolveModelAlias('vision-open')).toBe('qwen3.5:0.8b');
    });
  });

  describe('LayaProvider (System 1 Local Semantic Engine)', () => {
    const laya = new LayaProvider();

    it('decides coding tasks with deepseek-coder in <35ms', async () => {
      const start = performance.now();
      const res = await laya.decision({
        prompt: 'Escreva uma função TypeScript que valida um token JWT e extrai o tenantId.',
      });
      const elapsed = performance.now() - start;

      expect(res.result.decision).toBe('coding');
      expect(res.result.selectedModel).toBe('deepseek-coder:6.7b');
      expect(res.result.selectedProvider).toBe('ollama');
      expect(res.result.needsBackground).toBe(false);
      expect(res.result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(elapsed).toBeLessThan(35);
    });

    it('decides complex architecture with workflow and background execution in <35ms', async () => {
      const start = performance.now();
      const res = await laya.decision({
        prompt: 'Analise o meu projeto completo, decomponha a arquitetura em microserviços e gere um roadmap multi-agent.',
      });
      const elapsed = performance.now() - start;

      expect(res.result.decision).toBe('workflow');
      expect(res.result.selectedModel).toBe('claude-3-5-sonnet-latest');
      expect(res.result.selectedProvider).toBe('anthropic');
      expect(res.result.needsBackground).toBe(true);
      expect(elapsed).toBeLessThan(35);
    });

    it('decides greetings / fast conversational queries instantly', async () => {
      const res = await laya.decision({
        prompt: 'Olá, bom dia!',
      });

      expect(res.result.decision).toBe('fast');
      expect(res.result.selectedModel).toBe('qwen2.5:1.5b');
      expect(res.result.fastResponse).toBeDefined();
    });

    it('provides chat response using System 1 fast lane', async () => {
      const chatRes = await laya.chat({
        messages: [{ role: 'user', content: 'Oi' }],
      });
      const content = (chatRes as any).result?.message?.content;
      expect(content).toBeDefined();
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe('JevProvider (System 1 Cloud Fast Decision Model)', () => {
    const jev = new JevProvider();

    it('decides coding tasks and provides cloud heuristic fallback', async () => {
      const res = await jev.decision({
        prompt: 'Implemente um endpoint Express para upload de imagens com validação.',
      });

      expect(res.result.decision).toBe('coding');
      expect(res.result.selectedModel).toBe('deepseek-coder:6.7b');
      expect(res.model).toBe('jev-cloud');
    });

    it('decides workflow for complex architecture in cloud', async () => {
      const res = await jev.decision({
        prompt: 'Audite a arquitetura do sistema e recomende um pipeline de deploy.',
      });

      expect(res.result.decision).toBe('workflow');
      expect(res.result.needsBackground).toBe(true);
    });
  });

  describe('POST /v1/decide Endpoint', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/decide',
        payload: { prompt: 'Teste' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when prompt and messages are missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/decide',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 200 with coding decision for programming prompts', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/decide',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          prompt: 'Escreva um algoritmo de ordenação merge sort em Python',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.result.decision).toBe('coding');
      expect(json.result.selectedModel).toBe('deepseek-coder:6.7b');
      expect(json.executionTime).toBeLessThan(100);
    });

    it('returns 200 with workflow decision for multi-agent architecture prompts', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/decide',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          prompt: 'Decomponha a tarefa em um pipeline completo multi-agent para auditar o repositório',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.result.decision).toBe('workflow');
      expect(json.result.needsBackground).toBe(true);
    });
  });

  describe('POST /v1/chat/completions Transparent Cascade', () => {
    it('executes transparent cascade on coding prompt and attaches adaptive system1 metadata', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          model: 'auto',
          messages: [
            {
              role: 'user',
              content: 'Escreva uma função TypeScript que inverte uma string.',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.choices).toBeDefined();
      expect(json.choices[0]?.message?.content).toBeDefined();
      expect(json.choices[0]?.message?.content.length).toBeGreaterThan(0);
      expect(json._gateway?.system1Decision).toBeDefined();
      expect(json._gateway?.system1Decision?.decision).toBe('coding');
    }, 60000);

    it('executes dual-lane cascade and returns consolidated response with System 1 and code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          model: 'auto',
          dualLane: true,
          messages: [
            {
              role: 'user',
              content: 'Escreva uma função TypeScript que valida um email com regex.',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.choices).toBeDefined();
      const content = json.choices[0]?.message?.content;
      expect(content).toBeDefined();
      expect(content).toContain('/*');
      expect(json._gateway?.system1Decision?.consolidated).toBe(true);
    }, 60000);

    it('accepts model: "laya" or model: "decision" in /v1/chat/completions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          model: 'laya',
          messages: [
            {
              role: 'user',
              content: 'Qual é o status do sistema?',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.choices).toBeDefined();
      expect(json.choices[0]?.message?.content).toBeDefined();
      expect(json.model).toBe('laya-system1');
    });
  });

  describe('Worker BullMQ Orchestrator Processor Prompt Resilience', () => {
    it('accepts data.prompt when messages are absent without crashing', async () => {
      const { orchestratorProcessor } = await import('../../../apps/worker/src/processors');
      const chat = vi.fn(async () => ({
        result: { message: { content: 'resposta de teste' } },
        tokens: { total: 7 },
      }));
      const testRegistry = {
        resolveCandidates: vi.fn(async () => [{ name: 'test-provider', chat }]),
      };

      const fakeJob = {
        id: 'test-job-prompt-only',
        data: {
          prompt: 'Planeje um teste unitário para validar o sistema',
          __tenantId: 'default',
        },
      } as any;

      const res = await orchestratorProcessor(fakeJob, testRegistry as any);
      expect(res.success).toBe(true);
      expect(res.provider).toBe('orchestrator');
      expect((res.result as any)?.status).toBe('success');
      expect(chat).toHaveBeenCalledWith({
        messages: [{ role: 'user', content: 'Planeje um teste unitário para validar o sistema' }],
        model: 'auto',
      });
    });
  });
});
