/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { GlobalSettings } from '@hyperneo/shared';
import type { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager.ts';
import {
  createVoiceTranscribeLimiters,
  runVoiceTranscribe,
  type VoiceTranscribeDeps,
  type VoiceTranscribeLimiters,
  type VoiceTranscribeOutcome,
} from '../../../../src/lib/voice/transcribe-pipeline.ts';

type RequestData = { audioBase64?: string; mimeType?: string };
type RequestContext = { clientId?: string; sessionId?: string } | undefined;

const NOW = 1_770_000_000_000;

function wavBase64(): string {
  return Buffer.from('RIFFxxxxWAVEfmt data').toString('base64');
}

function createDeps(
  voice: Partial<NonNullable<GlobalSettings['voice']>> = {},
  limiters: VoiceTranscribeLimiters = createVoiceTranscribeLimiters(),
  credentialManager?: Pick<ProviderCredentialManager, 'getCredentials'>
): VoiceTranscribeDeps {
  const settings = {
    enabled: true,
    endpoint: 'https://ai0:8090/v1/audio/transcriptions',
    model: 'qwen3-asr-0.6b',
    allowPrivateNetwork: true,
    allowInsecureTls: true,
    ...voice,
  };
  return {
    settingsManager: { getGlobalSettings: () => ({ voice: settings }) as GlobalSettings },
    credentialManager,
    limiters,
    now: () => NOW,
  };
}

function transcribe(
  deps: VoiceTranscribeDeps,
  data: RequestData = {},
  context: RequestContext = { clientId: 'client-1', sessionId: 'session-1' }
): Promise<VoiceTranscribeOutcome> {
  return runVoiceTranscribe({
    data: { audioBase64: wavBase64(), mimeType: 'audio/wav', ...data },
    context,
    deps,
  });
}

describe('voice transcribe pipeline', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ text: 'hello world' }), { status: 200 })
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  it('transcribes audio through the full pipeline', async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = mock(async (_url: string | URL | Request, requestInit?: RequestInit) => {
      init = requestInit;
      return new Response(JSON.stringify({ text: 'hello world' }), { status: 200 });
    }) as typeof fetch;

    await expect(transcribe(createDeps())).resolves.toEqual({
      action: 'transcribed',
      text: 'hello world',
    });
    expect(init?.headers).toEqual({ Host: 'ai0:8090' });
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('denies invalid requests with byte-identical messages', async () => {
    const cases: Array<[RequestData, string]> = [
      [{ mimeType: 'audio/mp3' }, 'Voice transcription requires audio/wav input'],
      [{ audioBase64: '' }, 'Audio data is required'],
      [{ audioBase64: 'a'.repeat(13_981_017) }, 'Audio data exceeds the 10 MB voice input limit'],
      [{ audioBase64: 'AAAA!===' }, 'Audio data must be valid base64'],
    ];
    for (const [data, message] of cases) {
      await expect(transcribe(createDeps(), data)).resolves.toEqual({ action: 'denied', message });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('denies exhausted admission gates with byte-identical messages', async () => {
    const cases: Array<[(limiters: VoiceTranscribeLimiters) => void, string]> = [
      [
        (limiters) => {
          limiters.daemonRateWindow = { windowStartedAt: NOW, count: 20 };
        },
        'Voice transcription daemon-wide rate limit exceeded; please wait before trying again',
      ],
      [
        (limiters) => {
          limiters.daemonActive.count = 4;
        },
        'Too many voice transcription requests are already in progress',
      ],
      [
        (limiters) => {
          limiters.rateWindowsByClient.set('client-1', { windowStartedAt: NOW, count: 6 });
        },
        'Voice transcription rate limit exceeded; please wait before trying again',
      ],
      [
        (limiters) => {
          limiters.activeByClient.set('client-1', 1);
        },
        'Voice transcription is already in progress for this client',
      ],
    ];
    for (const [seed, message] of cases) {
      const limiters = createVoiceTranscribeLimiters();
      seed(limiters);
      const seededWindowCount = limiters.daemonRateWindow.count;
      const seededActiveCount = limiters.daemonActive.count;
      const seededClientActive = limiters.activeByClient.get('client-1');
      await expect(transcribe(createDeps({}, limiters))).resolves.toEqual({
        action: 'denied',
        message,
      });
      expect(limiters.daemonRateWindow.count).toBe(seededWindowCount);
      expect(limiters.daemonActive.count).toBe(seededActiveCount);
      expect(limiters.activeByClient.get('client-1')).toBe(seededClientActive);
    }
  });

  it('keys per-client admission by session id when no client id is present', async () => {
    const limiters = createVoiceTranscribeLimiters();
    limiters.activeByClient.set('session-1', 1);
    await expect(
      transcribe(createDeps({}, limiters), {}, { sessionId: 'session-1' })
    ).resolves.toEqual({
      action: 'denied',
      message: 'Voice transcription is already in progress for this client',
    });
  });

  it('denies invalid voice settings with byte-identical messages', async () => {
    const cases: Array<[Partial<NonNullable<GlobalSettings['voice']>>, string]> = [
      [{ enabled: false }, 'Voice input is disabled'],
      [{ endpoint: '' }, 'Voice transcription endpoint is required'],
      [{ model: '' }, 'Voice transcription model is required'],
      [{ endpoint: 'not a url' }, 'Voice transcription endpoint must be a valid URL'],
      [
        { endpoint: 'ftp://ai0/v1/audio/transcriptions' },
        'Voice transcription endpoint must use http:// or https://',
      ],
    ];
    for (const [voice, message] of cases) {
      await expect(transcribe(createDeps(voice))).resolves.toEqual({ action: 'denied', message });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses to send API keys over plaintext HTTP endpoints', async () => {
    await expect(
      transcribe(
        createDeps({ endpoint: 'http://ai0:9002/v1/audio/transcriptions', apiKey: 'sk-test' })
      )
    ).resolves.toEqual({
      action: 'denied',
      message:
        'Voice transcription API keys are only sent over HTTPS. Use an HTTPS endpoint or remove the API key.',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('propagates SSRF rejections from the fetch core', async () => {
    await expect(
      transcribe(
        createDeps({
          endpoint: 'http://192.168.1.20/v1/audio/transcriptions',
          allowPrivateNetwork: false,
        })
      )
    ).resolves.toEqual({
      action: 'failed',
      error:
        'Voice transcription endpoint targets a private, loopback, or link-local address. Enable private/LAN endpoints in Voice settings for trusted local ASR backends.',
    });
  });

  it('normalizes HTTP error responses', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Invalid model' } }), { status: 400 })
    ) as typeof fetch;
    await expect(transcribe(createDeps())).resolves.toEqual({
      action: 'failed',
      error: 'Invalid model',
    });
  });

  it('fails when the response has no text field', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({}), { status: 200 })
    ) as typeof fetch;
    await expect(transcribe(createDeps())).resolves.toEqual({
      action: 'failed',
      error: 'Transcription response did not include text',
    });
  });

  it('commits admission on pass and releases slots after completion', async () => {
    const limiters = createVoiceTranscribeLimiters();
    await transcribe(createDeps({}, limiters));
    expect(limiters.daemonRateWindow).toEqual({ windowStartedAt: NOW, count: 1 });
    expect(limiters.rateWindowsByClient.get('client-1')).toEqual({
      windowStartedAt: NOW,
      count: 1,
    });
    expect(limiters.daemonActive.count).toBe(0);
    expect(limiters.activeByClient.size).toBe(0);
  });

  it('releases admission slots when the fetch throws', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const limiters = createVoiceTranscribeLimiters();
    await expect(transcribe(createDeps({}, limiters))).resolves.toEqual({
      action: 'failed',
      error: 'ECONNREFUSED',
    });
    expect(limiters.daemonActive.count).toBe(0);
    expect(limiters.activeByClient.size).toBe(0);
    expect(limiters.daemonRateWindow.count).toBe(1);
  });

  it('caps daemon-wide concurrency across concurrent clients', async () => {
    const pendingFetches: Array<(response: Response) => void> = [];
    globalThis.fetch = mock(
      async () =>
        new Promise<Response>((resolve) => {
          pendingFetches.push(resolve);
        })
    ) as typeof fetch;
    const deps = createDeps();
    const requests = Array.from({ length: 4 }, (_, index) =>
      transcribe(deps, {}, { clientId: `client-${index}` })
    );
    await expect(transcribe(deps, {}, { clientId: 'client-5' })).resolves.toEqual({
      action: 'denied',
      message: 'Too many voice transcription requests are already in progress',
    });
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
    await expect(allRequests).resolves.toEqual(
      Array.from({ length: 4 }, () => ({ action: 'transcribed', text: 'done' }))
    );
  });

  it('resolves bearer authorization from the credential manager', async () => {
    const getCredentials = mock(async () => ({
      type: 'api_key' as const,
      apiKey: 'stored-key',
    }));
    let init: RequestInit | undefined;
    globalThis.fetch = mock(async (_url: string | URL | Request, requestInit?: RequestInit) => {
      init = requestInit;
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;

    await transcribe(
      createDeps(
        {
          endpoint: 'https://api.openai.com/v1/audio/transcriptions',
          model: 'whisper-1',
          apiKeyEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
        },
        createVoiceTranscribeLimiters(),
        { getCredentials } as unknown as Pick<ProviderCredentialManager, 'getCredentials'>
      )
    );

    expect(getCredentials).toHaveBeenCalledWith('voice-transcription');
    expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer stored-key');
  });

  it('refreshes endpoint and model from live settings inside the credential lock', async () => {
    const settingsSequence = [
      { endpoint: 'https://ai0:8090/v1/audio/transcriptions', model: 'old-model' },
      { endpoint: 'https://ai0:9090/v1/audio/transcriptions', model: 'new-model' },
    ];
    let calls = 0;
    const deps = createDeps();
    deps.settingsManager = {
      getGlobalSettings: () =>
        ({
          voice: {
            enabled: true,
            allowPrivateNetwork: true,
            allowInsecureTls: true,
            ...settingsSequence[Math.min(calls++, 1)],
          },
        }) as GlobalSettings,
    };
    const captured: { url?: string; model?: FormDataEntryValue | null } = {};
    globalThis.fetch = mock(async (url: string | URL | Request, requestInit?: RequestInit) => {
      captured.url = url.toString();
      captured.model = (requestInit?.body as FormData)?.get('model');
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;

    await expect(transcribe(deps)).resolves.toEqual({ action: 'transcribed', text: 'hello' });
    expect(captured.url).toBe('https://ai0:9090/v1/audio/transcriptions');
    expect(captured.model).toBe('new-model');
  });

  it('maps aborted runs to the pinned timeout message', async () => {
    const abortFetch = (init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
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
      await expect(transcribe(createDeps())).resolves.toEqual({
        action: 'failed',
        error: 'Voice transcription timed out after 120 seconds',
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
