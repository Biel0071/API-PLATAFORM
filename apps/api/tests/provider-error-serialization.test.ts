import { describe, expect, it } from 'vitest';
import { serializeProviderFailure } from '../src/lib/provider-error-serialization';

describe('provider error serialization', () => {
  it('preserves safe status and code while excluding upstream messages and secrets', () => {
    const result = serializeProviderFailure(Object.assign(new Error('token=private-secret'), {
      statusCode: 503,
      code: 'UPSTREAM_ERROR',
    }));

    expect(result).toEqual({
      statusCode: 503,
      errorCode: 'UPSTREAM_ERROR',
      message: 'Provider request failed',
    });
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });

  it('uses a safe fallback for invalid status and code values', () => {
    expect(serializeProviderFailure({ statusCode: 0, code: 'token=private' })).toEqual({
      statusCode: 500,
      errorCode: undefined,
      message: 'Provider request failed',
    });
  });
});
