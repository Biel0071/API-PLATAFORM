import type { FastifyInstance } from 'fastify';
import {
  clearGeminiStateCookie,
  finishGeminiOAuth,
  geminiDashboardRedirect,
  ProviderOAuthError,
} from '../services/provider-oauth.service';
import { reloadRegistryAfterMutation } from '../services/ai.service';

export async function registerGoogleOAuthCallback(app: FastifyInstance): Promise<void> {
  app.get('/oauth/google/gemini/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    try {
      const status = await finishGeminiOAuth({
        code: query.code,
        state: query.state,
        error: query.error,
        cookieHeader: request.headers.cookie,
      });
      if (status === 'connected') await reloadRegistryAfterMutation();
      reply.header('set-cookie', clearGeminiStateCookie());
      return reply.redirect(geminiDashboardRedirect(status));
    } catch (error) {
      reply.header('set-cookie', clearGeminiStateCookie());
      if (error instanceof ProviderOAuthError) {
        const code =
          error.code === 'OAUTH_UPSTREAM_ERROR' || error.code === 'OAUTH_UPSTREAM_UNAVAILABLE'
            ? 'error'
            : undefined;
        if (code) return reply.redirect(geminiDashboardRedirect(code));
        return reply
          .code(error.statusCode)
          .type('text/html; charset=utf-8')
          .send(
            '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Conexão do Gemini</title><body><main><h1>Não foi possível conectar a conta Google</h1><p>O estado da autorização expirou ou não corresponde a este navegador. Feche esta página e inicie a conexão novamente.</p><a href="/#/providers">Voltar aos provedores</a></main></body></html>',
          );
      }
      throw error;
    }
  });
}
