import { describe, expect, it } from 'bun:test';
import { AcpTransport, buildAcpProcessEnv } from '../../../../src/lib/acp/acp-transport';

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

  it('removes case-insensitive Windows variants before applying overrides', () => {
    const originalToken = process.env.anthropic_auth_token;
    process.env.anthropic_auth_token = 'secret';
    try {
      const env = buildAcpProcessEnv({ ANTHROPIC_AUTH_TOKEN: undefined }, false, 'win32');

      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.anthropic_auth_token).toBeUndefined();
    } finally {
      if (originalToken === undefined) delete process.env.anthropic_auth_token;
      else process.env.anthropic_auth_token = originalToken;
    }
  });

  it('does not inherit ambient variables when replacing the process environment', () => {
    const originalSecret = process.env.UNRELATED_PROVIDER_TOKEN;
    process.env.UNRELATED_PROVIDER_TOKEN = 'secret';
    try {
      expect(buildAcpProcessEnv({ PATH: '/safe/bin' }, true)).toEqual({ PATH: '/safe/bin' });
    } finally {
      if (originalSecret === undefined) delete process.env.UNRELATED_PROVIDER_TOKEN;
      else process.env.UNRELATED_PROVIDER_TOKEN = originalSecret;
    }
  });
});

describe('AcpTransport.sendRequest onSubmitted', () => {
  it('rejects when the onSubmitted callback throws instead of pending until timeout (#3744105279)', async () => {
    const transport = new AcpTransport({
      command: 'sleep',
      args: ['30'],
      requestTimeoutMs: 60_000,
    } as never);
    try {
      await expect(
        transport.sendRequest('session/prompt', { sessionId: 's' } as never, {
          onSubmitted: () => {
            throw new Error('markMessageSubmitted exploded');
          },
        })
      ).rejects.toThrow('markMessageSubmitted exploded');
    } finally {
      await transport.close();
    }
  });
});
