import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

describe('HTTP Routes, Authentication & Operational Gateway Core', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // Sign test tokens
    adminToken = app.jwt.sign({
      sub: 'admin_test_id',
      email: 'admin@enterprise.local',
      role: 'admin',
    });

    userToken = app.jwt.sign({
      sub: 'user_test_id',
      email: 'user@tenant.local',
      role: 'user',
      tenantId: 'tenant_123',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Health & Public Probes', () => {
    it('GET /v1/health responds 200 without authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/health',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.runtime).toBe('api-platform-Engine');
      expect(body.version).toBe('1.0.0-enterprise');
    }, 10_000);
  });

  describe('Authentication Gate (requireApiKey & JWT fallback)', () => {
    it('returns 401 MISSING_API_KEY when no credentials are provided on protected routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/missions',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('MISSING_API_KEY');
    });

    it('returns 401 INVALID_API_KEY when key is invalid string', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/missions',
        headers: { 'x-api-key': 'ap_invalid_fake_key_12345' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_API_KEY');
    });

    it('authenticates successfully with Admin JWT via Authorization: Bearer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/missions',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().missions)).toBe(true);
    });

    it('authenticates with lowercase "bearer " header scheme', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/missions',
        headers: { authorization: `bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('authenticates when JWT is provided in x-api-key header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/missions',
        headers: { 'x-api-key': adminToken },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('authenticates with user JWT and grants standard workflow scopes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/missions',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  describe('Missions API Endpoints', () => {
    let missionId: string;

    it('POST /v1/missions creates a new autonomous mission', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/missions',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          title: 'Auditoria de Conectividade de Gateway',
          objective: 'Testar criação e ciclo de vida de missões via HTTP',
          agentId: 'executive-brain',
          priority: 8,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.mission.id).toBeDefined();
      expect(body.mission.status).toBe('pending');
      missionId = body.mission.id;
    });

    it('POST /v1/missions/:id/steps appends step', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/missions/${missionId}/steps`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          title: 'Executar ping de rede nos nós de processamento',
          tool: 'network_ping',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().step.stepNumber).toBe(1);
    });

    it('POST /v1/missions/:id/complete marks mission finished', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/missions/${missionId}/complete`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          result: { pingOk: true, latencyMs: 12 },
          tokens: { prompt: 50, completion: 20 },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const check = await app.inject({
        method: 'GET',
        url: `/v1/missions/${missionId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(check.json().mission.status).toBe('completed');
    });
  });

  describe('Agents & Skills API Endpoints', () => {
    it('GET /v1/agents returns catalog of built-in and active agents', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/agents',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const agents = res.json().agents;
      expect(agents.length).toBeGreaterThanOrEqual(6);
      expect(agents.some((a: any) => a.id === 'executive-brain')).toBe(true);
    });

    it('GET /v1/skills returns list of engineering skills', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/skills',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const skills = res.json().skills;
      expect(skills.length).toBeGreaterThanOrEqual(8);
    });

    it('POST /v1/skills/:name/execute executes decision_recorder successfully', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/skills/decision_recorder/execute',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          parameters: {
            title: 'Isolamento de Runtime via Fastify 5',
            context: 'Garantir que a API funcione de forma autônoma e desacoplada',
            chosenOption: 'API Standalone com suporte a múltiplos clientes',
            rationale: 'Permite consumo universal por Lovable, CRMs, SaaS e Fênix OS',
          },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().result.success).toBe(true);
    });
  });

  describe('Runtime, Cluster & Monitoring Endpoints', () => {
    it('GET /v1/runtime returns node version and capabilities', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/runtime',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.success).toBe(true);
      expect(data.runtime.capabilities).toContain('chat');
    });

    it('GET /v1/sync/cluster returns cluster telemetry', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/sync/cluster',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('GET /v1/monitoring/dashboard returns consolidated operational metrics', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/monitoring/dashboard',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.system.status).toBe('ONLINE');
      expect(data.missions.total).toBeGreaterThanOrEqual(1);
    });

    it('GET /v1/events returns event stream history', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/events',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().events)).toBe(true);
    });
  });
});
