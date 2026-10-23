import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, mock } from 'bun:test';
import { createAnthropicMessagesBridgeServer } from '../../../../src/lib/providers/anthropic-messages-bridge/server';
import {
  releaseSessionKeyBridges,
  setKeyBridgeThinkingOff,
  shieldProviderKey,
  startProviderKeyBridge,
} from '../../../../src/lib/providers/provider-key-bridge';

describe('shieldProviderKey', () => {
  it('leaves anthropic routes and daemon placeholder tokens untouched', () => {
    const anthropic = { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'k' };
    const placeholder = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_AUTH_TOKEN: 'custom-endpoint:s-1',
    };
    expect(shieldProviderKey('anthropic', anthropic)).toBe(anthropic);
    expect(shieldProviderKey('custom', placeholder)).toBe(placeholder);
  });

  it('shields a real key even when the upstream is loopback', async () => {
    const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'loopback-key' };
    await startProviderKeyBridge('glm', env, 'glm:loopback');
    const shielded = shieldProviderKey('glm', env);
    expect(Object.values(shielded)).not.toContain('loopback-key');
    expect(shieldProviderKey('glm', shielded)).toBe(shielded);
  });

  it('refuses a keyed route whose bridge has not started', () => {
    expect(() =>
      shieldProviderKey('glm', {
        ANTHROPIC_BASE_URL: 'https://never-started.invalid',
        ANTHROPIC_AUTH_TOKEN: 'secret',
      })
    ).toThrow(/not started/);
  });
});

describe('startProviderKeyBridge', () => {
  it('stops a session-scoped bridge when its session is released', async () => {
    const env = { ANTHROPIC_BASE_URL: 'https://session.invalid', ANTHROPIC_AUTH_TOKEN: 's-key' };
    await startProviderKeyBridge('deepseek', env, 'deepseek:s-9');
    expect(shieldProviderKey('deepseek', env).ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127/);

    releaseSessionKeyBridges('s-9');

    expect(() => shieldProviderKey('deepseek', env)).toThrow(/not started/);
  });

  it('stops the previous bridge when a scope rotates its key', async () => {
    const base = 'https://rotate.invalid';
    const first = { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'old-key' };
    const second = { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'new-key' };
    await startProviderKeyBridge('kimi', first, 'kimi:rotate');
    const oldUrl = shieldProviderKey('kimi', first).ANTHROPIC_BASE_URL;
    await startProviderKeyBridge('kimi', second, 'kimi:rotate');

    expect(() => shieldProviderKey('kimi', first)).toThrow(/not started/);
    expect(shieldProviderKey('kimi', second).ANTHROPIC_BASE_URL).not.toBe(oldUrl);
  });

  it('replaces the provider key with a loopback bridge that requires its own token', async () => {
    const env = {
      ANTHROPIC_BASE_URL: 'https://upstream.invalid/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'real-provider-key',
      ANTHROPIC_API_KEY: '',
      API_TIMEOUT_MS: '120000',
    };
    await startProviderKeyBridge('glm', env);
    const shielded = shieldProviderKey('glm', env);

    expect(shielded.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(Object.values(shielded)).not.toContain('real-provider-key');
    expect(shielded.API_TIMEOUT_MS).toBe('120000');
    expect(shieldProviderKey('glm', env)).toEqual(shielded);

    const anonymous = await fetch(`${shielded.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    expect(anonymous.status).toBe(401);
  });
});

describe('createAnthropicMessagesBridgeServer access token', () => {
  it('forwards authorized requests with the configured key and named client headers', async () => {
    let captured: Record<string, string> = {};
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      captured = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const server = await createAnthropicMessagesBridgeServer({
      baseUrl: 'https://api.example.com',
      headers: { Authorization: 'Bearer real-key' },
      accessToken: 'bridge-token',
      forwardHeaders: ['x-opencode-session'],
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer bridge-token',
          'x-opencode-session': 's-1',
          'x-other': 'dropped',
        },
        body: '{}',
      });
      expect(response.status).toBe(200);
      expect(captured.authorization).toBe('Bearer real-key');
      expect(captured['x-opencode-session']).toBe('s-1');
      expect(captured['x-other']).toBeUndefined();
    } finally {
      server.stop();
    }
  });
});

describe('key bridge thinking off', () => {
  it('sends an explicit disabled thinking block only for sessions set to Off', async () => {
    const seen: Array<{ body: Record<string, unknown>; session: string | null }> = [];
    const upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        seen.push({
          body: JSON.parse(raw) as Record<string, unknown>,
          session: (req.headers['x-hyperneo-session'] as string | undefined) ?? null,
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [] }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as AddressInfo).port;
    try {
      const env = {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_AUTH_TOKEN: 'k',
      };
      await startProviderKeyBridge('deepseek', env, 'deepseek:s-off');
      const shielded = shieldProviderKey('deepseek', env, 's-off');
      expect(shielded.ANTHROPIC_CUSTOM_HEADERS).toBe('x-hyperneo-session: s-off');
      const send = () =>
        fetch(`${shielded.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${shielded.ANTHROPIC_AUTH_TOKEN}`,
            'content-type': 'application/json',
            'x-hyperneo-session': 's-off',
          },
          body: JSON.stringify({
            model: 'deepseek-v4-pro',
            max_tokens: 100,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'low' },
          }),
        });

      setKeyBridgeThinkingOff('s-off', true);
      await send();
      setKeyBridgeThinkingOff('s-off', false);
      await send();

      expect(seen[0].body.thinking).toEqual({ type: 'disabled' });
      expect(seen[0].body.output_config).toEqual({ effort: 'low' });
      expect(seen[0].session).toBeNull();
      expect(seen[1].body.thinking).toEqual({ type: 'adaptive' });
    } finally {
      releaseSessionKeyBridges('s-off');
      upstream.close();
    }
  });
});
