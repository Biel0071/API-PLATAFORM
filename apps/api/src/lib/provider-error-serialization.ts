export function serializeProviderFailure(error: unknown, fallbackStatus = 500): {
  statusCode: number;
  errorCode?: string;
  message: string;
} {
  const value = error as { statusCode?: unknown; status?: unknown; code?: unknown } | null;
  const candidate = Number(value?.statusCode ?? value?.status);
  const statusCode = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : fallbackStatus;
  const errorCode = typeof value?.code === 'string' && /^[A-Z0-9_-]{1,64}$/i.test(value.code)
    ? value.code
    : undefined;
  return { statusCode, errorCode, message: 'Provider request failed' };
}
