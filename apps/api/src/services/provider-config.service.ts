import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';

export interface ProviderForm {
  name: string;
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  accountId?: string;
  defaultModel?: string;
  embedModel?: string;
  defaultChat?: boolean;
}

type StoredSettings = Omit<ProviderForm, 'name' | 'enabled' | 'apiKey'> & { apiKeyEncrypted?: string };
const key = createHash('sha256').update(env.JWT_SECRET).digest();

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decrypt(value?: string): string | undefined {
  if (!value) return undefined;
  const [iv, tag, data] = value.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export async function saveProviderConfig(form: ProviderForm): Promise<void> {
  const current = await prisma.providerConfig.findUnique({ where: { name: form.name } });
  const old = (current?.settings ?? {}) as StoredSettings;
  const settings: StoredSettings = {
    baseUrl: form.baseUrl || undefined,
    accountId: form.accountId || undefined,
    defaultModel: form.defaultModel || undefined,
    embedModel: form.embedModel || undefined,
    defaultChat: form.defaultChat ?? old.defaultChat,
    apiKeyEncrypted: form.apiKey ? encrypt(form.apiKey) : old.apiKeyEncrypted,
  };
  await prisma.providerConfig.upsert({
    where: { name: form.name },
    create: { name: form.name, enabled: form.enabled, baseUrl: form.baseUrl, settings: settings as object },
    update: { enabled: form.enabled, baseUrl: form.baseUrl, settings: settings as object },
  });
  if (form.defaultChat === true) {
    const rows = await prisma.providerConfig.findMany();
    const updates = rows
      .filter((row) => row.name !== form.name && (row.settings as StoredSettings | null)?.defaultChat)
      .map((row) => prisma.providerConfig.update({
        where: { name: row.name },
        data: { settings: { ...(row.settings as StoredSettings), defaultChat: false } as object },
      }));
    if (updates.length) await prisma.$transaction(updates);
  }
}

export async function listProviderConfigs() {
  const rows = await prisma.providerConfig.findMany({ orderBy: { name: 'asc' } });
  return rows.map((row: typeof rows[0]) => {
    const settings = (row.settings ?? {}) as StoredSettings;
    return { ...row, settings: { ...settings, apiKeyEncrypted: undefined }, hasApiKey: Boolean(settings.apiKeyEncrypted) };
  });
}

export async function buildProviderEnv(baseEnv: Record<string, string | undefined> = process.env): Promise<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = { ...baseEnv };
  const rows = await prisma.providerConfig.findMany();
  for (const row of rows) {
    const s = (row.settings ?? {}) as StoredSettings;
    const name = row.name;
    const targets = name === 'cloudflare'
      ? { apiKey: 'CLOUDFLARE_API_TOKEN', baseUrl: 'CLOUDFLARE_BASE_URL', defaultModel: 'CLOUDFLARE_DEFAULT_MODEL', embedModel: 'CLOUDFLARE_EMBED_MODEL' }
      : name === 'anthropic'
      ? { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL', defaultModel: 'CLAUDE_DEFAULT_MODEL', embedModel: null }
      : name === 'xai'
        ? { apiKey: 'GROK_API_KEY', baseUrl: 'GROK_BASE_URL', defaultModel: 'GROK_DEFAULT_MODEL', embedModel: null }
        : { apiKey: `${name.toUpperCase()}_API_KEY`, baseUrl: `${name.toUpperCase()}_BASE_URL`, defaultModel: `${name.toUpperCase()}_DEFAULT_MODEL`, embedModel: `${name.toUpperCase()}_EMBED_MODEL` };
    if (!row.enabled) {
      for (const target of Object.values(targets)) if (target) delete result[target];
      if (name === 'cloudflare') delete result.CLOUDFLARE_ACCOUNT_ID;
      continue;
    }
    const secret = decrypt(s.apiKeyEncrypted);
    if (name === 'cloudflare') {
      if (s.accountId) result.CLOUDFLARE_ACCOUNT_ID = s.accountId;
      if (secret) result.CLOUDFLARE_API_TOKEN = secret;
      if (s.baseUrl) result.CLOUDFLARE_BASE_URL = s.baseUrl;
      if (s.defaultModel) result.CLOUDFLARE_DEFAULT_MODEL = s.defaultModel;
      if (s.embedModel) result.CLOUDFLARE_EMBED_MODEL = s.embedModel;
    } else if (name === 'ollama' || name === 'lmstudio' || name === 'comfyui' || name === 'forge' || name === 'invokeai') {
      if (s.baseUrl) result[targets.baseUrl] = s.baseUrl;
      if (s.defaultModel) result[targets.defaultModel] = s.defaultModel;
    } else {
      if (secret) result[targets.apiKey] = secret;
      if (s.baseUrl) result[targets.baseUrl] = s.baseUrl;
      if (s.defaultModel) result[targets.defaultModel] = s.defaultModel;
      if (s.embedModel && targets.embedModel) result[targets.embedModel] = s.embedModel;
    }
  }
  const configuredDefaults = rows.filter((row) => (row.settings as StoredSettings | null)?.defaultChat);
  const selectedDefault = configuredDefaults.find((row) => row.enabled);
  if (selectedDefault) result.DEFAULT_CHAT_PROVIDER = selectedDefault.name;
  else if (configuredDefaults.length) delete result.DEFAULT_CHAT_PROVIDER;
  return result;
}
