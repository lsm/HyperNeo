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
