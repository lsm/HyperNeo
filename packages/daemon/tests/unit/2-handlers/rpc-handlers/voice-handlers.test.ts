import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from 'vitest';
import type { CallContext, GlobalSettings, MessageHub } from '@hyperneo/shared';
import {
  registerVoiceHandlers,
  resetVoiceTranscriptionLimitsForTests,
} from '../../../../src/lib/rpc-handlers/voice-handlers';
import type { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager';
import type { SettingsManager } from '../../../../src/lib/settings-manager';

type RequestHandler = (data: unknown, context?: CallContext) => Promise<unknown>;

vi.mock('node:dns/promises', () => ({
  lookup: mock(async () => dnsLookupResults),
  Resolver: class {},
}));

let dnsLookupResults: Array<{ address: string; family: number }> = [
  { address: '93.184.216.34', family: 4 },
];

let defaultClientIndex = 0;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const defaultClientId = `default-client-${defaultClientIndex++}`;
  let messageIndex = 0;
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, (data, context) =>
        handler(
          data,
          context ?? {
            clientId: defaultClientId,
            sessionId: 'session-1',
            messageId: `message-${messageIndex++}`,
            method,
            timestamp: new Date().toISOString(),
          }
        )
      );
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
    resetVoiceTranscriptionLimitsForTests();
    dnsLookupResults = [{ address: '93.184.216.34', family: 4 }];
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
          allowPrivateNetwork: true,
        },
      })
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    dnsLookupResults = [{ address: '93.184.216.34', family: 4 }];
    mock.restore();
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
    expect(init?.headers).toEqual({ Host: 'ai0:8090' });
    expect(init?.tls).toEqual({ rejectUnauthorized: false, serverName: 'ai0' });
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

    expect(init?.headers).toEqual({
      Authorization: 'Bearer sk-test',
      Host: 'api.openai.com',
    });
    expect(init?.tls).toEqual({ rejectUnauthorized: true, serverName: 'api.openai.com' });
  });

  it('refuses to send API keys over plaintext HTTP endpoints', async () => {
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'http://ai0:9002/v1/audio/transcriptions',
          model: 'qwen3-asr',
          apiKey: 'sk-test',
        },
      })
    );
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'nope' }))
    ) as typeof fetch;

    await expect(
      hubData.handlers.get('voice.transcribe')?.({
        audioBase64: wavBase64(),
        mimeType: 'audio/wav',
      })
    ).rejects.toThrow('Voice transcription API keys are only sent over HTTPS');
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

    expect(init?.headers).toEqual({
      Authorization: 'Bearer stored-key',
      Host: 'api.openai.com',
    });
  });

  it('normalizes endpoint before comparing stored credential scope', async () => {
    const credentialManager = createCredentialManager('stored-key');
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://api.openai.com/v1/audio/transcriptions',
          model: 'whisper-1',
          hasApiKey: true,
          apiKeyEndpoint: 'https://API.OPENAI.com/v1/audio/transcriptions',
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

    expect(init?.headers).toEqual({
      Authorization: 'Bearer stored-key',
      Host: 'api.openai.com',
    });
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
    expect(init?.headers).toEqual({ Host: 'example.com' });
  });

  it('rejects private network endpoints unless explicitly allowed', async () => {
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'http://192.168.1.20/v1/audio/transcriptions',
          model: 'qwen3-asr',
        },
      })
    );
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'nope' }))
    ) as typeof fetch;

    await expect(
      hubData.handlers.get('voice.transcribe')?.({
        audioBase64: wavBase64(),
        mimeType: 'audio/wav',
      })
    ).rejects.toThrow(
      'Voice transcription endpoint targets a private, loopback, or link-local address'
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('allows private network endpoints when explicitly enabled', async () => {
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'http://192.168.1.20/v1/audio/transcriptions',
          model: 'qwen3-asr',
          allowPrivateNetwork: true,
        },
      })
    );
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'hello' }), { status: 200 })
    ) as typeof fetch;

    const result = await hubData.handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(result).toEqual({ text: 'hello' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://192.168.1.20/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('rejects fd00, link-local fe80::/10, site-local fec0::/10, and IPv4-mapped IPv6 private endpoints', async () => {
    const endpoints = [
      'http://[fd00::1]/v1/audio/transcriptions',
      'http://[fe90::1]/v1/audio/transcriptions',
      'http://[fec0::1]/v1/audio/transcriptions',
      'http://[::ffff:127.0.0.1]/v1/audio/transcriptions',
    ];
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'nope' }))
    ) as typeof fetch;

    for (const endpoint of endpoints) {
      const hubData = createMockMessageHub();
      registerVoiceHandlers(
        hubData.hub,
        createSettings({
          voice: {
            enabled: true,
            endpoint,
            model: 'qwen3-asr',
          },
        })
      );

      await expect(
        hubData.handlers.get('voice.transcribe')?.({
          audioBase64: wavBase64(),
          mimeType: 'audio/wav',
        })
      ).rejects.toThrow(
        'Voice transcription endpoint targets a private, loopback, or link-local address'
      );
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects unspecified IPv6/IPv4 wildcard endpoints', async () => {
    const endpoints = [
      'http://[::]:8484/v1/audio/transcriptions',
      'http://0.0.0.0:8484/v1/audio/transcriptions',
    ];
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'nope' }))
    ) as typeof fetch;

    for (const endpoint of endpoints) {
      const hubData = createMockMessageHub();
      registerVoiceHandlers(
        hubData.hub,
        createSettings({
          voice: {
            enabled: true,
            endpoint,
            model: 'qwen3-asr',
          },
        })
      );

      await expect(
        hubData.handlers.get('voice.transcribe')?.({
          audioBase64: wavBase64(),
          mimeType: 'audio/wav',
        })
      ).rejects.toThrow(
        'Voice transcription endpoint targets a private, loopback, or link-local address'
      );
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not retry a failed HTTP transcription POST on a second address', async () => {
    dnsLookupResults = [
      { address: '104.16.1.1', family: 4 },
      { address: '104.16.1.2', family: 4 },
    ];
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'http://asr.example.com/v1/audio/transcriptions',
          model: 'whisper-1',
        },
      })
    );
    const fetchedUrls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrls.push(url.toString());
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    await expect(
      hubData.handlers.get('voice.transcribe')?.({
        audioBase64: wavBase64(),
        mimeType: 'audio/wav',
      })
    ).rejects.toThrow('ECONNREFUSED');
    expect(fetchedUrls).toEqual(['http://104.16.1.1/v1/audio/transcriptions']);
  });

  it('fetches HTTPS endpoints by hostname so TLS validates the certificate', async () => {
    dnsLookupResults = [{ address: '93.184.216.34', family: 4 }];
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://asr.example.com/v1/audio/transcriptions',
          model: 'whisper-1',
        },
      })
    );
    let fetchedUrl: string | undefined;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrl = url.toString();
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;

    const result = await hubData.handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(result).toEqual({ text: 'hello' });
    expect(fetchedUrl).toBe('https://asr.example.com/v1/audio/transcriptions');
  });

  it('rejects audio payloads over 10 MB before forwarding', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'nope' }))
    ) as typeof fetch;

    await expect(
      handlers.get('voice.transcribe')?.({
        audioBase64: 'a'.repeat(13_981_017),
        mimeType: 'audio/wav',
      })
    ).rejects.toThrow('Audio data exceeds the 10 MB voice input limit');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed base64 audio before forwarding', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'nope' }))
    ) as typeof fetch;

    await expect(
      handlers.get('voice.transcribe')?.({
        audioBase64: 'AAAA!===',
        mimeType: 'audio/wav',
      })
    ).rejects.toThrow('Audio data must be valid base64');
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

  it('rejects concurrent transcription requests from the same client', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    globalThis.fetch = mock(
      async () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as typeof fetch;

    const firstRequest = handlers.get('voice.transcribe')?.(
      { audioBase64: wavBase64(), mimeType: 'audio/wav' },
      {
        clientId: 'client-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        method: 'voice.transcribe',
        timestamp: new Date().toISOString(),
      }
    );

    await expect(
      handlers.get('voice.transcribe')?.(
        { audioBase64: wavBase64(), mimeType: 'audio/wav' },
        {
          clientId: 'client-1',
          sessionId: 'session-1',
          messageId: 'message-2',
          method: 'voice.transcribe',
          timestamp: new Date().toISOString(),
        }
      )
    ).rejects.toThrow('Voice transcription is already in progress for this client');

    resolveFetch?.(new Response(JSON.stringify({ text: 'done' }), { status: 200 }));
    await expect(firstRequest).resolves.toEqual({ text: 'done' });
  });

  it('rejects daemon-wide concurrent transcription floods across clients', async () => {
    const pendingFetches: Array<(response: Response) => void> = [];
    globalThis.fetch = mock(
      async () =>
        new Promise<Response>((resolve) => {
          pendingFetches.push(resolve);
        })
    ) as typeof fetch;

    const requests = Array.from({ length: 4 }, (_, index) =>
      handlers.get('voice.transcribe')?.(
        { audioBase64: wavBase64(), mimeType: 'audio/wav' },
        {
          clientId: `client-${index}`,
          sessionId: 'session-1',
          messageId: `message-${index}`,
          method: 'voice.transcribe',
          timestamp: new Date().toISOString(),
        }
      )
    );

    await expect(
      handlers.get('voice.transcribe')?.(
        { audioBase64: wavBase64(), mimeType: 'audio/wav' },
        {
          clientId: 'client-5',
          sessionId: 'session-1',
          messageId: 'message-5',
          method: 'voice.transcribe',
          timestamp: new Date().toISOString(),
        }
      )
    ).rejects.toThrow('Too many voice transcription requests are already in progress');

    const allRequests = Promise.all(requests);
    let allSettled = false;
    allRequests.then(
      () => {
        allSettled = true;
      },
      () => {
        allSettled = true;
      }
    );
    while (!allSettled) {
      while (pendingFetches.length > 0) {
        pendingFetches.shift()!(new Response(JSON.stringify({ text: 'done' }), { status: 200 }));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await allRequests;
  });

  it('does not charge the daemon quota for per-client rejections', async () => {
    let firstResolve: ((response: Response) => void) | undefined;
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Promise<Response>((resolve) => {
          firstResolve = resolve;
        });
      }
      return new Response(JSON.stringify({ text: 'done' }), { status: 200 });
    }) as typeof fetch;

    const inflight = handlers.get('voice.transcribe')?.(
      { audioBase64: wavBase64(), mimeType: 'audio/wav' },
      {
        clientId: 'client-A',
        sessionId: 'session-1',
        messageId: 'inflight',
        method: 'voice.transcribe',
        timestamp: new Date().toISOString(),
      }
    );

    for (let i = 0; i < 20; i += 1) {
      await expect(
        handlers.get('voice.transcribe')?.(
          { audioBase64: wavBase64(), mimeType: 'audio/wav' },
          {
            clientId: 'client-A',
            sessionId: 'session-1',
            messageId: `rejected-${i}`,
            method: 'voice.transcribe',
            timestamp: new Date().toISOString(),
          }
        )
      ).rejects.toThrow('already in progress for this client');
    }

    firstResolve?.(new Response(JSON.stringify({ text: 'done' }), { status: 200 }));
    await expect(inflight).resolves.toEqual({ text: 'done' });

    const otherResult = await handlers.get('voice.transcribe')?.(
      { audioBase64: wavBase64(), mimeType: 'audio/wav' },
      {
        clientId: 'client-B',
        sessionId: 'session-1',
        messageId: 'other',
        method: 'voice.transcribe',
        timestamp: new Date().toISOString(),
      }
    );
    expect(otherResult).toEqual({ text: 'done' });
  });

  it('rate limits repeated transcription requests from the same client', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'hello' }), { status: 200 })
    ) as typeof fetch;
    const originalDateNow = Date.now;
    const now = Date.now();
    const dateNow = mock(() => now);
    Date.now = dateNow;

    try {
      for (let index = 0; index < 6; index++) {
        await handlers.get('voice.transcribe')?.(
          { audioBase64: wavBase64(), mimeType: 'audio/wav' },
          {
            clientId: 'client-2',
            sessionId: 'session-1',
            messageId: `message-${index}`,
            method: 'voice.transcribe',
            timestamp: new Date().toISOString(),
          }
        );
      }

      await expect(
        handlers.get('voice.transcribe')?.(
          { audioBase64: wavBase64(), mimeType: 'audio/wav' },
          {
            clientId: 'client-2',
            sessionId: 'session-1',
            messageId: 'message-7',
            method: 'voice.transcribe',
            timestamp: new Date().toISOString(),
          }
        )
      ).rejects.toThrow('Voice transcription rate limit exceeded; please wait before trying again');
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('rate limits repeated transcription requests across the daemon', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'hello' }), { status: 200 })
    ) as typeof fetch;
    const originalDateNow = Date.now;
    const now = Date.now();
    Date.now = mock(() => now);

    try {
      for (let index = 0; index < 20; index++) {
        await handlers.get('voice.transcribe')?.(
          { audioBase64: wavBase64(), mimeType: 'audio/wav' },
          {
            clientId: `daemon-client-${index}`,
            sessionId: 'session-1',
            messageId: `daemon-message-${index}`,
            method: 'voice.transcribe',
            timestamp: new Date().toISOString(),
          }
        );
      }

      await expect(
        handlers.get('voice.transcribe')?.(
          { audioBase64: wavBase64(), mimeType: 'audio/wav' },
          {
            clientId: 'daemon-client-21',
            sessionId: 'session-1',
            messageId: 'daemon-message-21',
            method: 'voice.transcribe',
            timestamp: new Date().toISOString(),
          }
        )
      ).rejects.toThrow(
        new Error(
          'Voice transcription daemon-wide rate limit exceeded; please wait before trying again'
        )
      );
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('rejects oversized transcription responses before buffering them', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('', {
          status: 200,
          headers: { 'content-length': String(256 * 1024 + 1) },
        })
    ) as typeof fetch;

    await expect(
      handlers.get('voice.transcribe')?.({ audioBase64: wavBase64(), mimeType: 'audio/wav' })
    ).rejects.toThrow('Voice transcription response exceeds the 256 KB limit');
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

  it('rejects transcription redirects to private endpoints', async () => {
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://api.openai.com/v1/audio/transcriptions',
          model: 'whisper-1',
        },
      })
    );
    const fetchedUrls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrls.push(url.toString());
      return new Response('', {
        status: 307,
        headers: { location: 'https://169.254.169.254/latest/meta-data/' },
      });
    }) as typeof fetch;

    await expect(
      hubData.handlers.get('voice.transcribe')?.({
        audioBase64: wavBase64(),
        mimeType: 'audio/wav',
      })
    ).rejects.toThrow(
      'Voice transcription endpoint targets a private, loopback, or link-local address'
    );
    expect(fetchedUrls).toEqual(['https://api.openai.com/v1/audio/transcriptions']);
  });

  it('rejects HTTPS-to-HTTP redirect downgrades before replaying audio', async () => {
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://api.openai.com/v1/audio/transcriptions',
          model: 'whisper-1',
        },
      })
    );
    const fetchedUrls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrls.push(url.toString());
      return new Response('', {
        status: 308,
        headers: { location: 'http://api.openai.com/v1/audio/transcriptions' },
      });
    }) as typeof fetch;

    await expect(
      hubData.handlers.get('voice.transcribe')?.({
        audioBase64: wavBase64(),
        mimeType: 'audio/wav',
      })
    ).rejects.toThrow('Voice transcription cannot follow an HTTPS-to-HTTP redirect');
    expect(fetchedUrls).toEqual(['https://api.openai.com/v1/audio/transcriptions']);
  });

  it('strips authorization on cross-host redirects', async () => {
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
    const redirectLocations = ['https://other.example.com/v1/audio/transcriptions'];
    let call = 0;
    const fetchedHeaders: Record<string, string>[] = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      fetchedHeaders.push((init?.headers as Record<string, string>) ?? {});
      const location = redirectLocations[call++];
      if (location) {
        return new Response('', { status: 307, headers: { location } });
      }
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    }) as typeof fetch;

    const result = await hubData.handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(result).toEqual({ text: 'ok' });
    expect(fetchedHeaders).toHaveLength(2);
    expect(fetchedHeaders[0].Authorization).toBe('Bearer sk-test');
    expect(fetchedHeaders[1].Authorization).toBeUndefined();
  });

  it('follows a 303 redirect as a bodyless GET', async () => {
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://api.openai.com/v1/audio/transcriptions',
          model: 'whisper-1',
        },
      })
    );
    const inits: RequestInit[] = [];
    let call = 0;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init ?? {});
      if (call++ === 0) {
        return new Response('', { status: 303, headers: { location: '/result' } });
      }
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    }) as typeof fetch;

    const result = await hubData.handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(result).toEqual({ text: 'ok' });
    expect(inits).toHaveLength(2);
    expect(inits[0].method).toBe('POST');
    expect(inits[0].body).toBeInstanceOf(FormData);
    expect(inits[1].method).toBe('GET');
    expect(inits[1].body).toBeUndefined();
  });

  it('strips embedded userinfo from the fetched endpoint URL', async () => {
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://key:secret@api.openai.com/v1/audio/transcriptions',
          model: 'whisper-1',
        },
      })
    );
    let fetchedUrl: string | undefined;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrl = url.toString();
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;

    const result = await hubData.handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(result).toEqual({ text: 'hello' });
    expect(fetchedUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('rejects CGNAT, broadcast, and NAT64 address ranges', async () => {
    const endpoints = [
      'http://100.64.0.1/v1/audio/transcriptions',
      'http://255.255.255.255/v1/audio/transcriptions',
      'http://[64:ff9b::1]/v1/audio/transcriptions',
    ];
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'nope' }))
    ) as typeof fetch;

    for (const endpoint of endpoints) {
      const hubData = createMockMessageHub();
      registerVoiceHandlers(
        hubData.hub,
        createSettings({ voice: { enabled: true, endpoint, model: 'qwen3-asr' } })
      );
      await expect(
        hubData.handlers.get('voice.transcribe')?.({
          audioBase64: wavBase64(),
          mimeType: 'audio/wav',
        })
      ).rejects.toThrow(
        'Voice transcription endpoint targets a private, loopback, or link-local address'
      );
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('pins resolved IPv6 addresses with brackets for HTTP endpoints', async () => {
    dnsLookupResults = [{ address: '2606:4700:4700::1111', family: 6 }];
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'http://asr.example.com/v1/audio/transcriptions',
          model: 'whisper-1',
        },
      })
    );
    let fetchedUrl: string | undefined;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      fetchedUrl = url.toString();
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;

    const result = await hubData.handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(result).toEqual({ text: 'hello' });
    expect(fetchedUrl).toBe('http://[2606:4700:4700::1111]/v1/audio/transcriptions');
  });

  it('times out transcription requests after 60 seconds', async () => {
    const abortFetch = (_init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = _init?.signal;
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort);
      });
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) =>
      abortFetch(init)
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

  it('does not misclassify fc/fd-prefixed public hostnames as private', async () => {
    const hubData = createMockMessageHub();
    registerVoiceHandlers(
      hubData.hub,
      createSettings({
        voice: {
          enabled: true,
          endpoint: 'https://fcaster.example.com/v1/audio/transcriptions',
          model: 'whisper-1',
        },
      })
    );
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'hello' }), { status: 200 })
    ) as typeof fetch;

    const result = await hubData.handlers.get('voice.transcribe')?.({
      audioBase64: wavBase64(),
      mimeType: 'audio/wav',
    });

    expect(result).toEqual({ text: 'hello' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://fcaster.example.com/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('rejects non-wav mime types before forwarding', async () => {
    await expect(
      handlers.get('voice.transcribe')?.({ audioBase64: wavBase64(), mimeType: 'audio/mp3' })
    ).rejects.toThrow(new Error('Voice transcription requires audio/wav input'));
  });

  it('rejects too many transcription redirects', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('', {
          status: 307,
          headers: { location: 'https://ai0:8090/v1/audio/transcriptions' },
        })
    ) as typeof fetch;

    await expect(
      handlers.get('voice.transcribe')?.({ audioBase64: wavBase64(), mimeType: 'audio/wav' })
    ).rejects.toThrow(new Error('Voice transcription redirected too many times'));
  });

  it('rejects invalid transcription redirects', async () => {
    globalThis.fetch = mock(
      async () => new Response('', { status: 307, headers: { location: 'http://[' } })
    ) as typeof fetch;

    await expect(
      handlers.get('voice.transcribe')?.({ audioBase64: wavBase64(), mimeType: 'audio/wav' })
    ).rejects.toThrow(new Error('Voice transcription returned an invalid redirect'));
  });

  it('rejects transcription redirects with non-HTTP protocols', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('', { status: 302, headers: { location: 'ftp://example.com/result' } })
    ) as typeof fetch;

    await expect(
      handlers.get('voice.transcribe')?.({ audioBase64: wavBase64(), mimeType: 'audio/wav' })
    ).rejects.toThrow(new Error('Voice transcription redirect must use http:// or https://'));
  });

  it('rejects oversized transcription responses streamed without a content-length', async () => {
    const oversized = new Uint8Array(256 * 1024 + 1);
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(oversized);
              controller.close();
            },
          })
        )
    ) as typeof fetch;

    await expect(
      handlers.get('voice.transcribe')?.({ audioBase64: wavBase64(), mimeType: 'audio/wav' })
    ).rejects.toThrow(new Error('Voice transcription response exceeds the 256 KB limit'));
  });
});
