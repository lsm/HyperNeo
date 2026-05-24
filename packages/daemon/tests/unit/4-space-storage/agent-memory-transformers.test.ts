import { describe, expect, test } from 'bun:test';
import { withoutAuthorization } from '../../../src/storage/repositories/agent-memory-fetch-options.ts';

describe('agent memory transformers embedder', () => {
  test('removes authorization headers from redirected fetch options', () => {
    const options = {
      method: 'GET',
      headers: {
        authorization: 'Bearer hf-secret',
        'x-request-id': 'request-1',
      },
    };

    const sanitized = withoutAuthorization(options);

    expect(sanitized).not.toBe(options);
    expect(new Headers(sanitized?.headers).get('authorization')).toBeNull();
    expect(new Headers(sanitized?.headers).get('x-request-id')).toBe('request-1');
  });
});
