import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

describe('local audio studio routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    token = app.jwt.sign({ sub: 'audio_user', email: 'audio@example.test', role: 'user', tenantId: 'tenant_audio' });
  });
  afterAll(async () => app.close());

  it('requires authentication and exposes unavailable local engines without claiming readiness', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/audio/health' });
    expect(unauthenticated.statusCode).toBe(401);

    const authenticated = await app.inject({ method: 'GET', url: '/v1/audio/health', headers: { authorization: `Bearer ${token}` } });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({ success: true, available: false, status: 'unavailable' });
  });

  it('validates payloads and requires authentication for ai-speech and transform routes', async () => {
    const unauthAiSpeech = await app.inject({ method: 'POST', url: '/v1/audio/ai-speech', payload: { prompt: 'Olá' } });
    expect(unauthAiSpeech.statusCode).toBe(401);

    const invalidAiSpeech = await app.inject({
      method: 'POST',
      url: '/v1/audio/ai-speech',
      headers: { authorization: `Bearer ${token}` },
      payload: { prompt: '' },
    });
    expect(invalidAiSpeech.statusCode).toBe(400);

    const invalidTransform = await app.inject({
      method: 'POST',
      url: '/v1/audio/transform',
      headers: { authorization: `Bearer ${token}` },
      payload: { audio: 'short', profile: 'invalid_profile' },
    });
    expect(invalidTransform.statusCode).toBe(400);
  });
});
