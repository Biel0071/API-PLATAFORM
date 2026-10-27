import { randomUUID } from 'node:crypto';
import type { AIProvider, TokenUsage } from './types';

export interface ProviderAttemptContext {
  correlationId: string;
  executionId: string;
  attemptNumber: number;
}

export function createProviderAttemptContext(
  input: Partial<Pick<ProviderAttemptContext, 'correlationId' | 'executionId'>> = {},
): ProviderAttemptContext {
  return { correlationId: input.correlationId || randomUUID(), executionId: input.executionId || randomUUID(), attemptNumber: 0 };
}

export interface ProviderAttemptRecord {
  correlationId: string;
  executionId: string;
  attemptNumber: number;
  providerAccountId?: string;
  provider: string;
  model: string;
  capability: string;
  success: boolean;
  errorCode?: string;
  durationMs: number;
  tokens: TokenUsage | null;
  estimatedCost: number | null;
  pricingConfigured: boolean;
  inputRatePer1k: number | null;
  outputRatePer1k: number | null;
  createdAt: Date;
}

export interface ProviderModelPrice {
  modelId: string;
  pricingConfigured: boolean;
  costPer1kInput: number;
  costPer1kOutput: number;
}

type AttemptTarget = { provider: string; providerAccountId?: string; model?: string; capability: string };

function observedTokens(input: unknown): TokenUsage | null {
  if (!input || typeof input !== 'object') return null;
  const usage: TokenUsage = {};
  for (const field of ['prompt', 'completion', 'total'] as const) {
    const value = (input as TokenUsage)[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647) usage[field] = value;
  }
  if (usage.total === undefined && usage.prompt !== undefined && usage.completion !== undefined) usage.total = usage.prompt + usage.completion;
  return Object.keys(usage).length ? usage : null;
}

/** Only observed usage is persisted. Tariffs are read before the real invocation. */
export class ProviderAttemptTracker {
  private readonly pending = new Set<Promise<unknown>>();
  private lastWarningAt = 0;
  constructor(private readonly dependencies: {
    loadPrices(provider: string): Promise<ProviderModelPrice[]>;
    record(record: ProviderAttemptRecord): Promise<void>;
    onError?: () => void;
  }) {}

  private reportError(): void {
    if (Date.now() - this.lastWarningAt < 30_000) return;
    this.lastWarningAt = Date.now();
    try { this.dependencies.onError?.(); } catch { /* Observation must never change inference. */ }
  }

  private async bestEffort<T>(operation: () => Promise<T>, fallback: T, deadlineMs = 50): Promise<T> {
    // A hung database must not create an unbounded number of pending writes/reads.
    if (this.pending.size >= 16) { this.reportError(); return fallback; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = Promise.resolve().then(operation);
    this.pending.add(running);
    const settled = running.catch(() => { this.reportError(); return fallback; }).finally(() => {
      this.pending.delete(running);
      if (timer) clearTimeout(timer);
    });
    return Promise.race([settled, new Promise<T>((resolve) => {
      timer = setTimeout(() => { this.reportError(); resolve(fallback); }, deadlineMs);
    })]);
  }

  async observe<T>(context: ProviderAttemptContext, target: AttemptTarget, invoke: () => Promise<T>): Promise<T> {
    const attemptNumber = ++context.attemptNumber;
    const createdAt = new Date();
    const internal = target.provider === 'laya' || target.provider === 'jev';
    const prices = internal ? [] : await this.bestEffort(() => this.dependencies.loadPrices(target.provider), [] as ProviderModelPrice[]);
    const start = Date.now();
    const finish = async (success: boolean, response?: any, error?: any) => {
      const tokens = internal ? null : observedTokens(response?.tokens ?? error?.tokens);
      const model = typeof response?.model === 'string' ? response.model : target.model || 'provider-default';
      const price = prices.find((entry) => entry.modelId === model);
      // Positive legacy tariffs predate the explicit flag and are already configured.
      const pricingConfigured = Boolean(price && (price.pricingConfigured || price.costPer1kInput > 0 || price.costPer1kOutput > 0) && Number.isFinite(price.costPer1kInput) && Number.isFinite(price.costPer1kOutput) && price.costPer1kInput >= 0 && price.costPer1kOutput >= 0);
      const calculatedCost = pricingConfigured && tokens?.prompt !== undefined && tokens.completion !== undefined
        ? tokens.prompt * price!.costPer1kInput / 1000 + tokens.completion * price!.costPer1kOutput / 1000
        : null;
      const estimatedCost = calculatedCost !== null && Number.isFinite(calculatedCost) ? calculatedCost : null;
      await this.bestEffort(() => this.dependencies.record({ ...target, model, correlationId: context.correlationId, executionId: context.executionId, attemptNumber,
          success, errorCode: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : success ? undefined : 'PROVIDER_ERROR',
          durationMs: Math.max(0, Date.now() - start), tokens, estimatedCost, pricingConfigured,
          inputRatePer1k: pricingConfigured ? price!.costPer1kInput : null,
          outputRatePer1k: pricingConfigured ? price!.costPer1kOutput : null, createdAt }), undefined, internal ? 0 : 50);
    };
    let response: any;
    try { response = await invoke(); } catch (error) { await finish(false, undefined, error); throw error; }
    if (response?.stream === true && response.chunks) {
      const originalChunks = response.chunks;
      response = { ...response, chunks: (async function* () {
        let completed = false;
        let failure: any;
        let tokens: TokenUsage | undefined;
        try {
          for await (const chunk of originalChunks) {
            if (chunk.type === 'usage') tokens = { prompt: chunk.promptTokens, completion: chunk.completionTokens, total: chunk.totalTokens };
            if (chunk.type === 'error') failure = { code: chunk.code || 'PROVIDER_ERROR' };
            yield chunk;
          }
          completed = true;
        } catch (error) { failure = error; throw error; }
        finally { await finish(completed && !failure, { model: response.model, tokens }, failure || (!completed ? { code: 'STREAM_INTERRUPTED' } : undefined)); }
      })() };
    } else await finish(true, response);
    return response as T;
  }

  /** Wrap methods, so image batches record each actual request rather than their envelope. */
  provider<T extends AIProvider>(context: ProviderAttemptContext, provider: T, providerAccountId?: string): T {
    const capabilities: Record<string, string> = { generateText: 'chat', chat: 'chat', vision: 'vision', decision: 'decision', embed: 'embedding', audio: 'audio', mission: 'mission', generateImage: 'image', generateMultiAngleView: 'image', imageToImage: 'image', videoToImage: 'image', removeBackground: 'image', inpaint: 'image', outpaint: 'image', upscale: 'image', inpainting: 'image', outpainting: 'image', inpaintImage: 'image', outpaintImage: 'image', controlnet: 'image' };
    return new Proxy(provider, { get: (original, key) => {
      const value = Reflect.get(original, key, original);
      if (typeof value !== 'function') return value;
      if (!capabilities[String(key)]) return value.bind(original);
      return (...args: any[]) => this.observe(context, { provider: original.name, providerAccountId, capability: capabilities[String(key)], model: args[0]?.model }, () => value.apply(original, args));
    } });
  }
}

export function providerAttemptData(record: ProviderAttemptRecord) {
  const { tokens, providerAccountId, ...fields } = record;
  return { ...fields, providerAccountId: providerAccountId || null,
    promptTokens: tokens?.prompt ?? null, completionTokens: tokens?.completion ?? null, totalTokens: tokens?.total ?? null };
}
