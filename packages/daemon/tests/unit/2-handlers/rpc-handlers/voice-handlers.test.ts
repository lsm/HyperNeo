import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { GlobalSettings } from '@hyperneo/shared';
import type { MessageHub } from '@hyperneo/shared';
import { registerVoiceHandlers } from '../../../../src/lib/rpc-handlers/voice-handlers';
import type { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager';
import type { SettingsManager } from '../../../../src/lib/settings-manager';

type RequestHandler = (data: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function createSettings(settings: Partial<GlobalSettings>): SettingsManager {
  return {
    getGlobalSettings: mock(() => settings as GlobalSettings),
  } as unknown as SettingsManager;
}

function wavBase64(): string {
  return Buffer.from('RIFFxxxxWAVEfmt data').toString('base64');
}

function createCredentialManager(apiKey: string): {
  manager: ProviderCredentialManager;
  getCredentials: ReturnType<typeof mock>;
} {
  const getCredentials = mock(async () => ({ type: 'api_key' as const, apiKey }));
  return {
    manager: { getCredentials } as unknown as ProviderCredentialManager,
    getCredentials,
  };
}

describe('voice RPC handlers', () => {
  const originalFetch = globalThis.fetch;
  let handlers: Map<string, RequestHandler>;

  beforeEach(() => {
    const hubData = createMockMessageHub();
    handlers = hubData.handlers;
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://ai0:8090/v1/audio/transcriptions',
          model: 'qwen3-asr-0.6b',
          allowInsecureTls: true,
        },
      })
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts wav multipart without authorization for local backends', async () => {
    let init: (RequestInit & { tls?: { rejectUnauthorized: boolean } }) | undefined;
    globalThis.fetch = mock(async (_url: string | URL | Request, requestInit?: RequestInit) => {
      init = requestInit as RequestInit & { tls?: { rejectUnauthorized: boolean } };
      return new Response(JSON.stringify({ text: 'hello world' }), { status: 200 });
    }) as typeof fetch;

    const result = await handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(result).toEqual({ text: 'hello world' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://ai0:8090/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' })
    );
    expect(init?.headers).toEqual({});
    expect(init?.tls).toEqual({ rejectUnauthorized: false });
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('adds bearer authorization for keyed OpenAI-compatible backends', async () => {
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://api.openai.com/v1/audio/transcriptions',
          model: 'whisper-1',
          apiKey: 'sk-test',
        },
      })
    );

    let init: RequestInit | undefined;
    globalThis.fetch = mock(async (_url: string | URL | Request, requestInit?: RequestInit) => {
      init = requestInit;
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;

    await hubData.handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(init?.headers).toEqual({ Authorization: 'Bearer sk-test' });
    expect('tls' in (init ?? {})).toBe(false);
  });

  it('resolves bearer authorization from the credential manager', async () => {
    const hubData = createMockMessageHub();
    const credentialManager = createCredentialManager('stored-key');
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://api.openai.com/v1/audio/transcriptions',
          model: 'whisper-1',
          hasApiKey: true,
          apiKeyEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
        },
      }),
      credentialManager.manager
    );

    let init: RequestInit | undefined;
    globalThis.fetch = mock(async (_url: string | URL | Request, requestInit?: RequestInit) => {
      init = requestInit;
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;

    await hubData.handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(init?.headers).toEqual({ Authorization: 'Bearer stored-key' });
  });

  it('does not send stored credentials to a different endpoint', async () => {
    const credentialManager = createCredentialManager('stored-key');
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://example.com/v1/audio/transcriptions',
          model: 'whisper-1',
          hasApiKey: true,
          apiKeyEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
        },
      }),
      credentialManager.manager
    );

    let init: RequestInit | undefined;
    globalThis.fetch = mock(async (_url: string | URL | Request, requestInit?: RequestInit) => {
      init = requestInit;
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;

    await hubData.handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(credentialManager.getCredentials).not.toHaveBeenCalled();
    expect(init?.headers).toEqual({});
  });

  it('rejects audio payloads over 3 MB before forwarding', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'nope' }))
    ) as typeof fetch;

    await expect(
      handlers.get('voice.transcribe')?.({
        audioBase64: 'a'.repeat(4_194_305),
        mimeType: 'audio/wav',
      })
    ).rejects.toThrow('Audio data exceeds the 3 MB voice input limit');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('normalizes OpenAI error JSON', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Invalid model' } }), { status: 400 })
    ) as typeof fetch;

    await expect(
      handlers.get('voice.transcribe')?.({ audioBase64: wavBase64(), mimeType: 'audio/wav' })
    ).rejects.toThrow('Invalid model');
  });

  it('normalizes arbitrary local server errors', async () => {
    globalThis.fetch = mock(
      async () => new Response('backend exploded', { status: 500 })
    ) as typeof fetch;

    await expect(
      handlers.get('voice.transcribe')?.({ audioBase64: wavBase64(), mimeType: 'audio/wav' })
    ).rejects.toThrow('backend exploded');
  });

  it('test connection sends a generated silent wav', async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = mock(async (_url: string | URL | Request, requestInit?: RequestInit) => {
      init = requestInit;
      return new Response(JSON.stringify({ text: '' }), { status: 200 });
    }) as typeof fetch;

    const result = await handlers.get('voice.testConnection')?.({});

    expect(result).toEqual({ text: '' });
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('times out transcription requests after 60 seconds', async () => {
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        })
    ) as typeof fetch;

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === 'function') queueMicrotask(callback);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

    try {
      await expect(
        handlers.get('voice.transcribe')?.({ audioBase64: wavBase64(), mimeType: 'audio/wav' })
      ).rejects.toThrow('Voice transcription timed out after 60 seconds');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
