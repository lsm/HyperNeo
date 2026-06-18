import { describe, expect, it } from 'bun:test';
import { buildAcpProcessEnv } from '../../../../src/lib/acp/acp-transport';

describe('buildAcpProcessEnv', () => {
  it('removes provider-managed routing env from ACP subprocess env', () => {
    const env = buildAcpProcessEnv({
      ANTHROPIC_BASE_URL: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
      KEEP_SESSION: 'session',
    });

    expect(env.KEEP_SESSION).toBe('session');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  });
});
