import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import {
  decryptCredential,
  encryptCredential,
  StoredProviderOAuth,
  withRedisLock,
} from '@api-platform/shared';
import { env } from '../config/env';
import { redis } from '../lib/redis';
import { prisma } from '../lib/prisma';
import {
  disconnectProviderOAuth,
  readProviderSettings,
  saveProviderOAuth,
} from './provider-config.service';

const HF_DEVICE_URL = 'https://huggingface.co/oauth/device';
const HF_TOKEN_URL = 'https://huggingface.co/oauth/token';
const GEMINI_SCOPE = 'https://www.googleapis.com/auth/generative-language.retriever';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const HF_FLOW_TTL_MAX_SECONDS = 900;
const GOOGLE_STATE_TTL_SECONDS = 600;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const flowIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);

const OPENAI_DEVICE_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const OPENAI_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_FLOW_TTL_MAX_SECONDS = 900;

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AUTH_URL = 'https://claude.ai/oauth/authorize';
const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const CLAUDE_SCOPE = 'org:create_api_key user:profile user:inference';

export class ProviderOAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'PROVIDER_OAUTH_ERROR',
  ) {
    super(message);
  }
}

export interface ProviderOAuthEnvironment {
  HUGGINGFACE_OAUTH_CLIENT_ID?: string;
  HUGGINGFACE_OAUTH_CLIENT_SECRET?: string;
  GEMINI_OAUTH_CLIENT_ID?: string;
  GEMINI_OAUTH_CLIENT_SECRET?: string;
  GEMINI_OAUTH_PROJECT_ID?: string;
  OPENAI_CODEX_CLIENT_ID?: string;
  CLAUDE_OAUTH_CLIENT_ID?: string;
  OAUTH_PUBLIC_BASE_URL?: string;
}

function publicHttpsBase(environment: ProviderOAuthEnvironment = process.env): URL | undefined {
  try {
    const url = new URL(environment.OAUTH_PUBLIC_BASE_URL ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function getProviderConnectionOptions(environment: ProviderOAuthEnvironment = process.env) {
  const publicBase = publicHttpsBase(environment);
  const googleConfigured = Boolean(
    environment.GEMINI_OAUTH_CLIENT_ID &&
    environment.GEMINI_OAUTH_CLIENT_SECRET &&
    environment.GEMINI_OAUTH_PROJECT_ID &&
    publicBase,
  );
  const huggingfaceConfigured = Boolean(environment.HUGGINGFACE_OAUTH_CLIENT_ID);
  const portals: Record<string, string> = {
    openai: 'https://platform.openai.com/api-keys',
    anthropic: 'https://console.anthropic.com/settings/keys',
    xai: 'https://console.x.ai/',
    gemini: 'https://aistudio.google.com/app/apikey',
    groq: 'https://console.groq.com/keys',
    openrouter: 'https://openrouter.ai/keys',
    huggingface: 'https://huggingface.co/settings/tokens',
    cloudflare: 'https://dash.cloudflare.com/profile/api-tokens',
  };
  const options: Record<string, unknown> = {};
  for (const name of Object.keys(portals)) {
    options[name] = {
      apiKey: { enabled: true, portalUrl: portals[name] },
      oauth: {
        enabled:
          name === 'huggingface'
            ? huggingfaceConfigured
            : name === 'gemini'
              ? googleConfigured
              : name === 'openai'
                ? true
                : name === 'anthropic'
                  ? true
                  : false,
        type:
          name === 'openai'
            ? 'device_code'
            : name === 'anthropic'
              ? 'pkce'
              : name === 'huggingface'
                ? 'device_code'
                : name === 'gemini'
                  ? 'authorization_code'
                  : undefined,
        reason:
          name === 'huggingface' && !huggingfaceConfigured
            ? 'OAuth do Hugging Face requer um Client ID configurado no servidor.'
            : name === 'gemini' && !googleConfigured
              ? 'OAuth do Gemini requer callback HTTPS, Client ID/secret e projeto Google configurados no servidor.'
              : undefined,
      },
    };
  }
  for (const name of ['ollama', 'lmstudio', 'comfyui', 'forge', 'invokeai']) {
    options[name] = { localServer: { enabled: true } };
  }
  return options;
}

function basicAuthorization(clientId: string, clientSecret?: string): Record<string, string> {
  return clientSecret
    ? { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` }
    : {};
}

async function safeJson(response: Response): Promise<Record<string, any>> {
  return response.json().catch(() => ({})) as Promise<Record<string, any>>;
}

function oauthRequestSignal(): AbortSignal {
  return AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
}

function redisFlowKey(flowId: string): string {
  return `apiplatform:provider-oauth:huggingface:${createHash('sha256').update(flowId).digest('hex')}`;
}

async function resolveOAuthAccount(
  provider: 'gemini' | 'huggingface' | 'openai' | 'anthropic',
  accountId?: string,
): Promise<{ id: string; legacyProviderConfigId: string | null; providerConfigId: string } | null> {
  if (accountId) {
    const account = await prisma.providerAccount.findUnique({
      where: { id: accountId },
      include: { provider: true },
    });
    if (
      !account ||
      account.disconnectedAt ||
      (!account.enabled && !account.oauthNeedsReauth) ||
      account.provider.name !== provider
    )
      throw new ProviderOAuthError(
        'Conexão não encontrada ou indisponível.',
        404,
        'ACCOUNT_NOT_FOUND',
      );
    return {
      id: account.id,
      legacyProviderConfigId: account.legacyProviderConfigId,
      providerConfigId: account.providerId,
    };
  }
  const legacy = await prisma.providerConfig.findUnique({ where: { name: provider } });
  if (!legacy) return null;
  const account = await prisma.providerAccount.findUnique({
    where: { legacyProviderConfigId: legacy.id },
  });
  if (!account || account.disconnectedAt || (!account.enabled && !account.oauthNeedsReauth))
    return null;
  return {
    id: account.id,
    legacyProviderConfigId: account.legacyProviderConfigId,
    providerConfigId: account.providerId,
  };
}

async function saveAccountOAuth(
  provider: 'gemini' | 'huggingface' | 'openai' | 'anthropic',
  accountId: string,
  oauth: StoredProviderOAuth,
): Promise<void> {
  const account = await prisma.providerAccount.findUnique({
    where: { id: accountId },
    include: { provider: true },
  });
  if (
    !account ||
    account.disconnectedAt ||
    (!account.enabled && !account.oauthNeedsReauth) ||
    account.provider.name !== provider
  )
    throw new ProviderOAuthError(
      'Conexão não encontrada ou indisponível.',
      404,
      'ACCOUNT_NOT_FOUND',
    );
  const update = await prisma.providerAccount.updateMany({
    where: {
      id: accountId,
      disconnectedAt: null,
      OR: [{ enabled: true }, { oauthNeedsReauth: true }],
    },
    data: {
      enabled: true,
      authMode: 'oauth',
      oauthProvider: oauth.provider,
      oauthAccessTokenEncrypted: oauth.accessTokenEncrypted,
      oauthRefreshTokenEncrypted: oauth.refreshTokenEncrypted ?? null,
      oauthExpiresAt: oauth.expiresAt ? new Date(oauth.expiresAt) : null,
      oauthScope: oauth.scope ?? null,
      oauthNeedsReauth: oauth.reauthRequired ?? false,
      healthOk: null,
      healthCheckedAt: null,
      healthLatencyMs: null,
    },
  });
  if (!update.count)
    throw new ProviderOAuthError(
      'Conexão não encontrada ou indisponível.',
      404,
      'ACCOUNT_NOT_FOUND',
    );
  if (account.legacyProviderConfigId) await saveProviderOAuth(provider, oauth);
}

export async function startHuggingFaceDeviceFlow(
  accountId?: string,
  environment: ProviderOAuthEnvironment = process.env,
) {
  const clientId = environment.HUGGINGFACE_OAUTH_CLIENT_ID;
  if (!clientId)
    throw new ProviderOAuthError(
      'OAuth do Hugging Face não está configurado no servidor.',
      503,
      'OAUTH_NOT_CONFIGURED',
    );
  const account = await resolveOAuthAccount('huggingface', accountId);
  const form = new URLSearchParams({ client_id: clientId, scope: 'inference-api' });
  const response = await fetch(HF_DEVICE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...basicAuthorization(clientId, environment.HUGGINGFACE_OAUTH_CLIENT_SECRET),
    },
    body: form,
    signal: oauthRequestSignal(),
  }).catch(() => {
    throw new ProviderOAuthError(
      'Não foi possível iniciar a autorização do Hugging Face.',
      502,
      'OAUTH_UPSTREAM_UNAVAILABLE',
    );
  });
  const data = await safeJson(response);
  if (!response.ok || typeof data.device_code !== 'string' || typeof data.user_code !== 'string') {
    throw new ProviderOAuthError(
      'O Hugging Face não iniciou a autorização. Tente novamente ou use uma API key.',
      502,
      'OAUTH_UPSTREAM_ERROR',
    );
  }
  if (data.device_code.length > 8_192 || data.user_code.length > 64) {
    throw new ProviderOAuthError(
      'O Hugging Face retornou um código inválido. Tente novamente.',
      502,
      'OAUTH_UPSTREAM_ERROR',
    );
  }
  const flowId = randomBytes(32).toString('base64url');
  const expiresIn = Math.max(60, Math.min(Number(data.expires_in) || 600, HF_FLOW_TTL_MAX_SECONDS));
  const interval = Math.max(1, Math.min(Number(data.interval) || 5, 30));
  let verificationUri = 'https://huggingface.co/oauth/authorize/device';
  try {
    const candidate = new URL(String(data.verification_uri ?? ''));
    if (candidate.protocol === 'https:' && candidate.origin === 'https://huggingface.co')
      verificationUri = candidate.toString();
  } catch {
    /* usa o destino oficial fixo */
  }
  const flow = {
    providerAccountId: account?.id ?? null,
    deviceCodeEncrypted: encryptCredential(data.device_code as string, env.JWT_SECRET),
    expiresAt: Date.now() + expiresIn * 1_000,
    intervalSeconds: interval,
  };
  await redis.set(redisFlowKey(flowId), JSON.stringify(flow), 'EX', expiresIn);
  return {
    flowId,
    userCode: data.user_code,
    verificationUri,
    expiresAt: new Date(flow.expiresAt).toISOString(),
    intervalSeconds: interval,
  };
}

export async function pollHuggingFaceDeviceFlow(
  input: unknown,
  accountId?: string,
  environment: ProviderOAuthEnvironment = process.env,
) {
  const { flowId } = z.object({ flowId: flowIdSchema }).parse(input);
  return withRedisLock(redis, `apiplatform:provider-oauth:huggingface-poll:${flowId}`, async () => {
    const key = redisFlowKey(flowId);
    const encoded = await redis.get(key);
    if (!encoded)
      throw new ProviderOAuthError(
        'Código expirado ou já utilizado. Inicie uma nova conexão.',
        404,
        'OAUTH_FLOW_NOT_FOUND',
      );
    let flow: {
      deviceCodeEncrypted: string;
      expiresAt: number;
      intervalSeconds: number;
      providerAccountId?: string | null;
    };
    try {
      flow = JSON.parse(encoded);
    } catch {
      await redis.del(key);
      throw new ProviderOAuthError(
        'Fluxo OAuth inválido. Inicie uma nova conexão.',
        400,
        'OAUTH_FLOW_INVALID',
      );
    }
    if (flow.expiresAt <= Date.now()) {
      await redis.del(key);
      throw new ProviderOAuthError(
        'O código do Hugging Face expirou. Inicie uma nova conexão.',
        410,
        'OAUTH_FLOW_EXPIRED',
      );
    }
    if (accountId && flow.providerAccountId !== accountId) {
      throw new ProviderOAuthError(
        'Código OAuth não pertence a esta conexão.',
        400,
        'OAUTH_ACCOUNT_MISMATCH',
      );
    }
    const clientId = environment.HUGGINGFACE_OAUTH_CLIENT_ID;
    if (!clientId)
      throw new ProviderOAuthError(
        'OAuth do Hugging Face não está configurado no servidor.',
        503,
        'OAUTH_NOT_CONFIGURED',
      );
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: decryptCredential(flow.deviceCodeEncrypted, env.JWT_SECRET) ?? '',
      client_id: clientId,
    });
    const response = await fetch(HF_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...basicAuthorization(clientId, environment.HUGGINGFACE_OAUTH_CLIENT_SECRET),
      },
      body: form,
      signal: oauthRequestSignal(),
    }).catch(() => {
      throw new ProviderOAuthError(
        'Não foi possível consultar a autorização do Hugging Face.',
        502,
        'OAUTH_UPSTREAM_UNAVAILABLE',
      );
    });
    const data = await safeJson(response);
    if (!response.ok && data.error === 'authorization_pending')
      return { status: 'pending' as const, intervalSeconds: flow.intervalSeconds };
    if (!response.ok && data.error === 'slow_down') {
      flow.intervalSeconds = Math.min(flow.intervalSeconds + 5, 60);
      await redis.set(
        key,
        JSON.stringify(flow),
        'EX',
        Math.max(1, Math.ceil((flow.expiresAt - Date.now()) / 1_000)),
      );
      return { status: 'pending' as const, intervalSeconds: flow.intervalSeconds };
    }
    if (!response.ok && data.error === 'access_denied') {
      await redis.del(key);
      return { status: 'denied' as const };
    }
    if (!response.ok && data.error === 'expired_token') {
      await redis.del(key);
      return { status: 'expired' as const };
    }
    if (!response.ok || typeof data.access_token !== 'string') {
      throw new ProviderOAuthError(
        'O Hugging Face não concluiu a autorização. Tente novamente.',
        502,
        'OAUTH_UPSTREAM_ERROR',
      );
    }
    const oauth: StoredProviderOAuth = {
      provider: 'huggingface',
      accessTokenEncrypted: encryptCredential(data.access_token, env.JWT_SECRET),
      expiresAt:
        typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1_000 : undefined,
      scope: typeof data.scope === 'string' ? data.scope : 'inference-api',
      reauthRequired: false,
    };
    if (flow.providerAccountId)
      await saveAccountOAuth('huggingface', flow.providerAccountId, oauth);
    else await saveProviderOAuth('huggingface', oauth);
    await redis.del(key);
    return { status: 'connected' as const };
  });
}

function geminiRedirectUri(environment: ProviderOAuthEnvironment): string | undefined {
  const base = publicHttpsBase(environment);
  if (
    !base ||
    !environment.GEMINI_OAUTH_CLIENT_ID ||
    !environment.GEMINI_OAUTH_CLIENT_SECRET ||
    !environment.GEMINI_OAUTH_PROJECT_ID
  )
    return undefined;
  return `${base.toString().replace(/\/$/, '')}/oauth/google/gemini/callback`;
}

export async function startGeminiOAuth(
  accountId?: string,
  environment: ProviderOAuthEnvironment = process.env,
) {
  const redirectUri = geminiRedirectUri(environment);
  const clientId = environment.GEMINI_OAUTH_CLIENT_ID;
  if (!redirectUri || !clientId)
    throw new ProviderOAuthError(
      'OAuth do Gemini exige callback HTTPS público, cliente OAuth e projeto Google configurados.',
      503,
      'OAUTH_NOT_CONFIGURED',
    );
  const account = await resolveOAuthAccount('gemini', accountId);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await redis.set(
    `apiplatform:provider-oauth:gemini:${state}`,
    JSON.stringify({
      verifierEncrypted: encryptCredential(verifier, env.JWT_SECRET),
      providerAccountId: account?.id ?? null,
    }),
    'EX',
    GOOGLE_STATE_TTL_SECONDS,
  );
  const authorization = new URL(GOOGLE_AUTH_URL);
  authorization.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GEMINI_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return { state, authorizationUrl: authorization.toString(), redirectUri };
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  return cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function sameState(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function finishGeminiOAuth(
  input: unknown,
  accountId?: string,
  environment: ProviderOAuthEnvironment = process.env,
): Promise<'connected' | 'denied'> {
  const parsed = z
    .object({
      code: z.string().max(4_096).optional(),
      state: z
        .string()
        .regex(/^[A-Za-z0-9_-]{32,64}$/)
        .optional(),
      error: z.string().max(128).optional(),
      cookieHeader: z.string().max(8_192).optional(),
    })
    .safeParse(input);
  if (!parsed.success) {
    throw new ProviderOAuthError(
      'Resposta OAuth inválida. Inicie a conexão novamente.',
      400,
      'OAUTH_CALLBACK_INVALID',
    );
  }
  const { code, state, error, cookieHeader } = parsed.data;
  if (!state || !sameState(cookieValue(cookieHeader, 'gemini_oauth_state'), state)) {
    throw new ProviderOAuthError(
      'Estado OAuth inválido ou não iniciado neste navegador.',
      400,
      'OAUTH_STATE_INVALID',
    );
  }
  const key = `apiplatform:provider-oauth:gemini:${state}`;
  const stored = (await redis.eval(
    "local value = redis.call('get', KEYS[1]); if value then redis.call('del', KEYS[1]); end; return value",
    1,
    key,
    '',
  )) as string | null;
  if (!stored)
    throw new ProviderOAuthError(
      'Estado OAuth expirado ou já utilizado. Inicie novamente.',
      400,
      'OAUTH_STATE_EXPIRED',
    );
  const flowState = JSON.parse(stored) as {
    verifierEncrypted?: string;
    providerAccountId?: string | null;
  };
  if (accountId && flowState.providerAccountId !== accountId) {
    throw new ProviderOAuthError(
      'Estado OAuth não pertence a esta conexão.',
      400,
      'OAUTH_ACCOUNT_MISMATCH',
    );
  }
  if (error === 'access_denied') return 'denied';
  if (!code || error)
    throw new ProviderOAuthError(
      'A autorização do Gemini não foi concluída.',
      400,
      'OAUTH_AUTHORIZATION_DENIED',
    );
  const clientId = environment.GEMINI_OAUTH_CLIENT_ID;
  const clientSecret = environment.GEMINI_OAUTH_CLIENT_SECRET;
  const redirectUri = geminiRedirectUri(environment);
  if (!clientId || !clientSecret || !redirectUri)
    throw new ProviderOAuthError(
      'OAuth do Gemini não está configurado no servidor.',
      503,
      'OAUTH_NOT_CONFIGURED',
    );
  const verifier = decryptCredential(flowState.verifierEncrypted, env.JWT_SECRET);
  if (!verifier)
    throw new ProviderOAuthError(
      'Estado OAuth inválido. Inicie novamente.',
      400,
      'OAUTH_STATE_INVALID',
    );
  const form = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: oauthRequestSignal(),
  }).catch(() => {
    throw new ProviderOAuthError(
      'Não foi possível concluir a autorização do Google.',
      502,
      'OAUTH_UPSTREAM_UNAVAILABLE',
    );
  });
  const token = await safeJson(response);
  if (!response.ok || typeof token.access_token !== 'string') {
    throw new ProviderOAuthError(
      'O Google recusou a autorização do Gemini. Tente novamente ou use uma API key.',
      502,
      'OAUTH_UPSTREAM_ERROR',
    );
  }
  const old = flowState.providerAccountId
    ? await prisma.providerAccount.findUnique({ where: { id: flowState.providerAccountId } })
    : await readProviderSettings('gemini');
  const oldOAuth =
    old && 'oauthRefreshTokenEncrypted' in old
      ? old.oauthProvider === 'google' && old.oauthRefreshTokenEncrypted
        ? { refreshTokenEncrypted: old.oauthRefreshTokenEncrypted }
        : undefined
      : old?.oauth?.provider === 'google'
        ? old.oauth
        : undefined;
  const oauth: StoredProviderOAuth = {
    provider: 'google',
    accessTokenEncrypted: encryptCredential(token.access_token, env.JWT_SECRET),
    refreshTokenEncrypted:
      typeof token.refresh_token === 'string'
        ? encryptCredential(token.refresh_token, env.JWT_SECRET)
        : oldOAuth?.refreshTokenEncrypted,
    expiresAt:
      typeof token.expires_in === 'number' ? Date.now() + token.expires_in * 1_000 : undefined,
    scope: typeof token.scope === 'string' ? token.scope : GEMINI_SCOPE,
    reauthRequired: false,
  };
  if (flowState.providerAccountId)
    await saveAccountOAuth('gemini', flowState.providerAccountId, oauth);
  else await saveProviderOAuth('gemini', oauth);
  return 'connected';
}

export async function disconnectProviderOAuthAccount(
  name: unknown,
  accountId?: string,
): Promise<void> {
  const provider = z.enum(['gemini', 'huggingface', 'openai', 'anthropic']).parse(name);
  const targetAccountId =
    accountId ??
    (await (async () => {
      const legacy = await prisma.providerConfig.findUnique({ where: { name: provider } });
      if (!legacy) return undefined;
      const account = await prisma.providerAccount.findUnique({
        where: { legacyProviderConfigId: legacy.id },
      });
      return account?.disconnectedAt ? undefined : account?.id;
    })());
  if (targetAccountId) {
    const account = await prisma.providerAccount.findUnique({
      where: { id: targetAccountId },
      include: { provider: true },
    });
    if (!account || account.disconnectedAt || account.provider.name !== provider)
      throw new ProviderOAuthError('Conexão não encontrada.', 404, 'ACCOUNT_NOT_FOUND');
    const hasApiKey = Boolean(account.credentialEncrypted);
    const result = await prisma.providerAccount.updateMany({
      where: { id: targetAccountId, disconnectedAt: null },
      data: {
        authMode: hasApiKey ? 'apiKey' : 'oauth',
        oauthProvider: null,
        oauthAccessTokenEncrypted: null,
        oauthRefreshTokenEncrypted: null,
        oauthExpiresAt: null,
        oauthScope: null,
        oauthNeedsReauth: !hasApiKey,
        enabled: hasApiKey ? account.enabled : false,
      },
    });
    if (!result.count)
      throw new ProviderOAuthError('Conexão não encontrada.', 404, 'ACCOUNT_NOT_FOUND');
    if (account.legacyProviderConfigId) await disconnectProviderOAuth(provider);
    return;
  }
  await disconnectProviderOAuth(provider);
}

export function clearGeminiStateCookie(): string {
  return 'gemini_oauth_state=; Path=/oauth/google/gemini/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
}

export function geminiStateCookie(state: string): string {
  return `gemini_oauth_state=${state}; Path=/oauth/google/gemini/callback; Max-Age=${GOOGLE_STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function geminiDashboardRedirect(
  status: 'connected' | 'denied' | 'error',
  environment: ProviderOAuthEnvironment = process.env,
): string {
  const base = publicHttpsBase(environment);
  if (!base) return '/#/providers';
  return `${base.toString().replace(/\/$/, '')}/#/providers?oauth=${status}`;
}


function redisOpenAIFlowKey(flowId: string): string {
  return `apiplatform:provider-oauth:openai-codex:${createHash('sha256').update(flowId).digest('hex')}`;
}

function redisClaudeStateKey(state: string): string {
  return `apiplatform:provider-oauth:claude:${createHash('sha256').update(state).digest('hex')}`;
}

async function ensureProviderAccountForOAuth(
  provider: 'gemini' | 'huggingface' | 'openai' | 'anthropic',
  accountId?: string,
): Promise<{ id: string; legacyProviderConfigId: string | null; providerConfigId: string }> {
  const existing = await resolveOAuthAccount(provider, accountId);
  if (existing) return existing;

  const config = await prisma.providerConfig.upsert({
    where: { name: provider },
    create: { name: provider, enabled: true, baseUrl: null, settings: {} },
    update: { enabled: true },
  });

  const account = await prisma.providerAccount.create({
    data: {
      providerId: config.id,
      displayName: `${provider.charAt(0).toUpperCase() + provider.slice(1)} (Account Login)`,
      authMode: 'oauth',
      enabled: true,
      legacyProviderConfigId: config.id,
    },
  });

  return {
    id: account.id,
    legacyProviderConfigId: account.legacyProviderConfigId,
    providerConfigId: account.providerId,
  };
}

export async function startOpenAICodexDeviceFlow(
  accountId?: string,
  environment: ProviderOAuthEnvironment = process.env,
) {
  const clientId = environment.OPENAI_CODEX_CLIENT_ID ?? OPENAI_CODEX_CLIENT_ID;
  const account = await resolveOAuthAccount('openai', accountId);
  const response = await fetch(OPENAI_DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
    signal: oauthRequestSignal(),
  }).catch(() => {
    throw new ProviderOAuthError(
      'Não foi possível iniciar a autorização com o OpenAI Codex.',
      502,
      'OAUTH_UPSTREAM_UNAVAILABLE',
    );
  });
  const data = await safeJson(response);
  if (!response.ok || typeof data.device_auth_id !== 'string' || typeof data.user_code !== 'string') {
    throw new ProviderOAuthError(
      'A OpenAI não iniciou o código do dispositivo. Tente novamente ou use uma API key.',
      502,
      'OAUTH_UPSTREAM_ERROR',
    );
  }
  const flowId = randomBytes(32).toString('base64url');
  const expiresIn = Math.max(60, Math.min(Number(data.expires_in) || 900, OPENAI_FLOW_TTL_MAX_SECONDS));
  const interval = Math.max(1, Math.min(Number(data.interval) || 5, 30));
  const verificationUri = 'https://auth.openai.com/codex/device';
  const flow = {
    providerAccountId: account?.id ?? null,
    deviceAuthIdEncrypted: encryptCredential(data.device_auth_id, env.JWT_SECRET),
    userCode: data.user_code,
    expiresAt: Date.now() + expiresIn * 1_000,
    intervalSeconds: interval,
  };
  await redis.set(redisOpenAIFlowKey(flowId), JSON.stringify(flow), 'EX', expiresIn);
  return {
    flowId,
    userCode: data.user_code,
    verificationUri,
    expiresAt: new Date(flow.expiresAt).toISOString(),
    intervalSeconds: interval,
  };
}

export async function pollOpenAICodexDeviceFlow(
  input: unknown,
  accountId?: string,
  environment: ProviderOAuthEnvironment = process.env,
) {
  const { flowId } = z.object({ flowId: flowIdSchema }).parse(input);
  return withRedisLock(redis, `apiplatform:provider-oauth:openai-poll:${flowId}`, async () => {
    const key = redisOpenAIFlowKey(flowId);
    const encoded = await redis.get(key);
    if (!encoded)
      throw new ProviderOAuthError(
        'Código expirado ou já utilizado. Inicie uma nova conexão.',
        404,
        'OAUTH_FLOW_NOT_FOUND',
      );
    let flow: {
      deviceAuthIdEncrypted: string;
      userCode: string;
      expiresAt: number;
      intervalSeconds: number;
      providerAccountId?: string | null;
    };
    try {
      flow = JSON.parse(encoded);
    } catch {
      await redis.del(key);
      throw new ProviderOAuthError(
        'Fluxo OAuth inválido. Inicie uma nova conexão.',
        400,
        'OAUTH_FLOW_INVALID',
      );
    }
    if (flow.expiresAt <= Date.now()) {
      await redis.del(key);
      throw new ProviderOAuthError(
        'O código do dispositivo expirou. Inicie uma nova conexão.',
        410,
        'OAUTH_FLOW_EXPIRED',
      );
    }
    if (accountId && flow.providerAccountId !== accountId) {
      throw new ProviderOAuthError(
        'Código OAuth não pertence a esta conexão.',
        400,
        'OAUTH_ACCOUNT_MISMATCH',
      );
    }
    const clientId = environment.OPENAI_CODEX_CLIENT_ID ?? OPENAI_CODEX_CLIENT_ID;
    const deviceAuthId = decryptCredential(flow.deviceAuthIdEncrypted, env.JWT_SECRET) ?? '';
    const response = await fetch(OPENAI_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: flow.userCode,
        client_id: clientId,
      }),
      signal: oauthRequestSignal(),
    }).catch(() => {
      throw new ProviderOAuthError(
        'Não foi possível consultar a autorização do OpenAI Codex.',
        502,
        'OAUTH_UPSTREAM_UNAVAILABLE',
      );
    });
    const data = await safeJson(response);
    if (!response.ok && (data.error === 'authorization_pending' || response.status === 403 || response.status === 404)) {
      return { status: 'pending' as const, intervalSeconds: flow.intervalSeconds };
    }
    if (!response.ok && data.error === 'slow_down') {
      flow.intervalSeconds = Math.min(flow.intervalSeconds + 5, 60);
      await redis.set(
        key,
        JSON.stringify(flow),
        'EX',
        Math.max(1, Math.ceil((flow.expiresAt - Date.now()) / 1_000)),
      );
      return { status: 'pending' as const, intervalSeconds: flow.intervalSeconds };
    }
    if (!response.ok && data.error === 'access_denied') {
      await redis.del(key);
      return { status: 'denied' as const };
    }
    if (!response.ok && data.error === 'expired_token') {
      await redis.del(key);
      return { status: 'expired' as const };
    }

    let accessToken = typeof data.access_token === 'string' ? data.access_token : undefined;
    let refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : undefined;
    let expiresIn = typeof data.expires_in === 'number' ? data.expires_in : undefined;

    if (!accessToken && typeof data.authorization_code === 'string') {
      const exchangeForm = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: data.authorization_code,
        redirect_uri: 'https://auth.openai.com/deviceauth/callback',
      });
      const exchangeRes = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: exchangeForm,
        signal: oauthRequestSignal(),
      }).catch(() => undefined);
      if (exchangeRes) {
        const tokenData = await safeJson(exchangeRes);
        if (typeof tokenData.access_token === 'string') {
          accessToken = tokenData.access_token;
          refreshToken = typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token : undefined;
          expiresIn = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : undefined;
        }
      }
    }

    if (!accessToken) {
      if (!response.ok) {
        throw new ProviderOAuthError(
          'A OpenAI não concluiu a autorização. Tente novamente.',
          502,
          'OAUTH_UPSTREAM_ERROR',
        );
      }
      return { status: 'pending' as const, intervalSeconds: flow.intervalSeconds };
    }

    const oauth: StoredProviderOAuth = {
      provider: 'openai',
      accessTokenEncrypted: encryptCredential(accessToken, env.JWT_SECRET),
      refreshTokenEncrypted: refreshToken ? encryptCredential(refreshToken, env.JWT_SECRET) : undefined,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1_000 : undefined,
      scope: typeof data.scope === 'string' ? data.scope : 'openid profile email offline_access',
      reauthRequired: false,
    };

    let targetAccountId = flow.providerAccountId;
    if (!targetAccountId) {
      const ensured = await ensureProviderAccountForOAuth('openai');
      targetAccountId = ensured.id;
    }
    await saveAccountOAuth('openai', targetAccountId, oauth);
    await redis.del(key);
    return { status: 'connected' as const };
  });
}

export async function startClaudeOAuth(
  accountId?: string,
  environment: ProviderOAuthEnvironment = process.env,
) {
  const clientId = environment.CLAUDE_OAUTH_CLIENT_ID ?? CLAUDE_CLIENT_ID;
  const account = await resolveOAuthAccount('anthropic', accountId);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  await redis.set(
    redisClaudeStateKey(state),
    JSON.stringify({
      verifierEncrypted: encryptCredential(verifier, env.JWT_SECRET),
      providerAccountId: account?.id ?? null,
    }),
    'EX',
    600,
  );

  const authUrl = new URL(CLAUDE_AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: CLAUDE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();

  return { state, authorizationUrl: authUrl.toString(), redirectUri: CLAUDE_REDIRECT_URI };
}

export async function finishClaudeOAuth(
  input: unknown,
  accountId?: string,
  environment: ProviderOAuthEnvironment = process.env,
) {
  const parsed = z
    .object({
      code: z.string().min(1).max(4_096),
      state: z.string().min(1).max(128),
    })
    .parse(input);

  const key = redisClaudeStateKey(parsed.state);
  const encoded = await redis.get(key);
  if (!encoded) {
    throw new ProviderOAuthError(
      'Sessão de autorização do Claude expirada ou inválida. Inicie novamente.',
      400,
      'OAUTH_STATE_INVALID',
    );
  }
  let flowState: { verifierEncrypted: string; providerAccountId?: string | null };
  try {
    flowState = JSON.parse(encoded);
  } catch {
    await redis.del(key);
    throw new ProviderOAuthError('Sessão OAuth corrompida. Inicie novamente.', 400, 'OAUTH_STATE_INVALID');
  }

  if (accountId && flowState.providerAccountId && flowState.providerAccountId !== accountId) {
    throw new ProviderOAuthError('Sessão OAuth não pertence a esta conexão.', 400, 'OAUTH_ACCOUNT_MISMATCH');
  }

  const clientId = environment.CLAUDE_OAUTH_CLIENT_ID ?? CLAUDE_CLIENT_ID;
  const verifier = decryptCredential(flowState.verifierEncrypted, env.JWT_SECRET);
  if (!verifier) {
    await redis.del(key);
    throw new ProviderOAuthError('Código verificador corrompido.', 500, 'INTERNAL_ERROR');
  }

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: parsed.code,
    redirect_uri: CLAUDE_REDIRECT_URI,
    code_verifier: verifier,
  });

  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: oauthRequestSignal(),
  }).catch(() => {
    throw new ProviderOAuthError(
      'Não foi possível concluir a autorização do Claude com a Anthropic.',
      502,
      'OAUTH_UPSTREAM_UNAVAILABLE',
    );
  });

  const data = await safeJson(response);
  if (!response.ok || typeof data.access_token !== 'string') {
    throw new ProviderOAuthError(
      'A Anthropic recusou o código de autorização. Tente novamente.',
      502,
      'OAUTH_UPSTREAM_ERROR',
    );
  }

  const oauth: StoredProviderOAuth = {
    provider: 'anthropic',
    accessTokenEncrypted: encryptCredential(data.access_token, env.JWT_SECRET),
    refreshTokenEncrypted:
      typeof data.refresh_token === 'string'
        ? encryptCredential(data.refresh_token, env.JWT_SECRET)
        : undefined,
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1_000 : undefined,
    scope: typeof data.scope === 'string' ? data.scope : CLAUDE_SCOPE,
    reauthRequired: false,
  };

  let targetAccountId = flowState.providerAccountId ?? accountId;
  if (!targetAccountId) {
    const ensured = await ensureProviderAccountForOAuth('anthropic');
    targetAccountId = ensured.id;
  }
  await saveAccountOAuth('anthropic', targetAccountId, oauth);
  await redis.del(key);
  return 'connected' as const;
}

export interface CLISessionInfo {
  provider: 'openai' | 'anthropic' | 'gemini';
  available: boolean;
  source: string;
  accountTier?: string;
  hasRefreshToken: boolean;
  path: string;
}

export function getAvailableCLISessions(): Record<'openai' | 'anthropic' | 'gemini', CLISessionInfo> {
  const home = os.homedir();
  const codexFile = path.join(home, '.codex', 'auth.json');
  const claudeFile = path.join(home, '.claude', '.credentials.json');
  const geminiFile = path.join(home, '.gemini', 'oauth_creds.json');

  let openaiAvailable = false;
  let openaiTier = 'plus';
  let openaiHasRefresh = false;
  if (fs.existsSync(codexFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(codexFile, 'utf8'));
      const token = c.tokens?.access_token ?? c.access_token;
      if (typeof token === 'string' && token.length > 20) {
        openaiAvailable = true;
        openaiHasRefresh = Boolean(c.tokens?.refresh_token ?? c.refresh_token);
        if (c.tokens?.account_id) openaiTier = 'pro';
      }
    } catch {
      // ignore
    }
  }

  let claudeAvailable = false;
  let claudeTier = 'pro';
  let claudeHasRefresh = false;
  if (fs.existsSync(claudeFile)) {
    try {
      const cl = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
      const oauth = cl.claudeAiOauth ?? cl;
      if (typeof oauth.accessToken === 'string' && oauth.accessToken.length > 20) {
        claudeAvailable = true;
        claudeHasRefresh = Boolean(oauth.refreshToken);
        if (typeof oauth.subscriptionType === 'string') claudeTier = oauth.subscriptionType;
      }
    } catch {
      // ignore
    }
  }

  let geminiAvailable = false;
  let geminiTier = 'pro';
  let geminiHasRefresh = false;
  if (fs.existsSync(geminiFile)) {
    try {
      const g = JSON.parse(fs.readFileSync(geminiFile, 'utf8'));
      if (typeof g.access_token === 'string' && g.access_token.length > 20) {
        geminiAvailable = true;
        geminiHasRefresh = Boolean(g.refresh_token);
      }
    } catch {
      // ignore
    }
  }

  return {
    openai: {
      provider: 'openai',
      available: openaiAvailable,
      source: 'OpenAI Codex Desktop/CLI (~/.codex/auth.json)',
      accountTier: openaiTier,
      hasRefreshToken: openaiHasRefresh,
      path: codexFile,
    },
    anthropic: {
      provider: 'anthropic',
      available: claudeAvailable,
      source: 'Claude Code CLI (~/.claude/.credentials.json)',
      accountTier: claudeTier,
      hasRefreshToken: claudeHasRefresh,
      path: claudeFile,
    },
    gemini: {
      provider: 'gemini',
      available: geminiAvailable,
      source: 'Google Gemini CLI (~/.gemini/oauth_creds.json)',
      accountTier: geminiTier,
      hasRefreshToken: geminiHasRefresh,
      path: geminiFile,
    },
  };
}

export async function importLocalCLICredentials(
  provider: 'openai' | 'anthropic' | 'gemini',
  accountId?: string,
) {
  const home = os.homedir();
  if (provider === 'openai') {
    const codexFile = path.join(home, '.codex', 'auth.json');
    if (!fs.existsSync(codexFile)) {
      throw new ProviderOAuthError('Arquivo de sessão do Codex (~/.codex/auth.json) não encontrado.', 404);
    }
    const content = JSON.parse(fs.readFileSync(codexFile, 'utf8'));
    const accessToken = content.tokens?.access_token ?? content.access_token;
    const refreshToken = content.tokens?.refresh_token ?? content.refresh_token;
    if (!accessToken || typeof accessToken !== 'string') {
      throw new ProviderOAuthError('Token de acesso não encontrado no arquivo do Codex.', 400);
    }
    const oauth: StoredProviderOAuth = {
      provider: 'openai',
      accessTokenEncrypted: encryptCredential(accessToken, env.JWT_SECRET),
      refreshTokenEncrypted: refreshToken ? encryptCredential(refreshToken, env.JWT_SECRET) : undefined,
      expiresAt: Date.now() + 3600 * 24 * 7 * 1000,
      scope: 'openid profile email offline_access',
      reauthRequired: false,
    };
    let targetAccountId = accountId;
    if (!targetAccountId) {
      const ensured = await ensureProviderAccountForOAuth('openai');
      targetAccountId = ensured.id;
    }
    await saveAccountOAuth('openai', targetAccountId, oauth);
    const tier = content.tokens?.account_id ? 'pro' : 'plus';
    await prisma.providerAccount.updateMany({
      where: { id: targetAccountId },
      data: {
        settings: { accountTier: tier, defaultModel: 'gpt-4o' },
      },
    });
    return { success: true, status: 'connected', provider: 'openai', tier };
  } else if (provider === 'anthropic') {
    const claudeFile = path.join(home, '.claude', '.credentials.json');
    if (!fs.existsSync(claudeFile)) {
      throw new ProviderOAuthError('Arquivo de sessão do Claude (~/.claude/.credentials.json) não encontrado.', 404);
    }
    const content = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
    const oauthData = content.claudeAiOauth ?? content;
    const accessToken = oauthData.accessToken;
    const refreshToken = oauthData.refreshToken;
    if (!accessToken || typeof accessToken !== 'string') {
      throw new ProviderOAuthError('Token de acesso não encontrado no arquivo do Claude.', 400);
    }
    const oauth: StoredProviderOAuth = {
      provider: 'anthropic',
      accessTokenEncrypted: encryptCredential(accessToken, env.JWT_SECRET),
      refreshTokenEncrypted: refreshToken ? encryptCredential(refreshToken, env.JWT_SECRET) : undefined,
      expiresAt: oauthData.expiresAt ? Number(oauthData.expiresAt) : Date.now() + 3600 * 24 * 7 * 1000,
      scope: Array.isArray(oauthData.scopes) ? oauthData.scopes.join(' ') : 'org:create_api_key user:profile user:inference',
      reauthRequired: false,
    };
    let targetAccountId = accountId;
    if (!targetAccountId) {
      const ensured = await ensureProviderAccountForOAuth('anthropic');
      targetAccountId = ensured.id;
    }
    await saveAccountOAuth('anthropic', targetAccountId, oauth);
    const tier = oauthData.subscriptionType || 'pro';
    await prisma.providerAccount.updateMany({
      where: { id: targetAccountId },
      data: {
        settings: { accountTier: tier, defaultModel: 'claude-3-5-sonnet-20240620' },
      },
    });
    return { success: true, status: 'connected', provider: 'anthropic', tier };
  } else if (provider === 'gemini') {
    const geminiFile = path.join(home, '.gemini', 'oauth_creds.json');
    if (!fs.existsSync(geminiFile)) {
      throw new ProviderOAuthError('Arquivo de sessão do Gemini (~/.gemini/oauth_creds.json) não encontrado.', 404);
    }
    const content = JSON.parse(fs.readFileSync(geminiFile, 'utf8'));
    const accessToken = content.access_token;
    const refreshToken = content.refresh_token;
    if (!accessToken || typeof accessToken !== 'string') {
      throw new ProviderOAuthError('Token de acesso não encontrado no arquivo do Gemini.', 400);
    }
    const oauth: StoredProviderOAuth = {
      provider: 'google',
      accessTokenEncrypted: encryptCredential(accessToken, env.JWT_SECRET),
      refreshTokenEncrypted: refreshToken ? encryptCredential(refreshToken, env.JWT_SECRET) : undefined,
      expiresAt: content.expiry_date ? Number(content.expiry_date) : Date.now() + 3600 * 1000,
      scope: content.scope || GEMINI_SCOPE,
      reauthRequired: false,
    };
    let targetAccountId = accountId;
    if (!targetAccountId) {
      const ensured = await ensureProviderAccountForOAuth('gemini');
      targetAccountId = ensured.id;
    }
    await saveAccountOAuth('gemini', targetAccountId, oauth);
    await prisma.providerAccount.updateMany({
      where: { id: targetAccountId },
      data: {
        settings: { accountTier: 'pro', defaultModel: 'gemini-1.5-pro' },
      },
    });
    return { success: true, status: 'connected', provider: 'gemini', tier: 'pro' };
  }
  throw new ProviderOAuthError('Provedor não suportado para importação CLI.', 400);
}
