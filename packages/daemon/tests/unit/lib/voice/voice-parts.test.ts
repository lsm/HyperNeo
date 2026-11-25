import { describe, expect, test } from 'bun:test';
import type { VoiceSettings } from '@hyperneo/shared';
import { resolveSpeechPart } from '../../../../src/lib/voice/voice-parts.ts';

const credentials = {
  getCredentials: async (id: string) =>
    id === 'voice-transcription' ? { type: 'api_key' as const, apiKey: 'sk-openai' } : null,
};
const voice = (speechEndpoint?: string): VoiceSettings => ({
  enabled: true,
  endpoint: 'https://api.openai.com/v1/audio/transcriptions',
  model: 'whisper-1',
  hasApiKey: true,
  apiKeyEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
  ...(speechEndpoint
    ? {
        speech: {
          provider: 'openai',
          endpoint: speechEndpoint,
          model: 'gpt-4o-mini-tts',
          voice: 'alloy',
        },
      }
    : {}),
});

describe('resolveSpeechPart', () => {
  test('a speech part on the key host gets the same key', async () => {
    expect(await resolveSpeechPart(voice('https://api.openai.com'), credentials)).toEqual({
      endpoint: 'https://api.openai.com',
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      key: 'sk-openai',
    });
  });

  test('a speech part on another host gets no key', async () => {
    expect(await resolveSpeechPart(voice('https://tts.example.com'), credentials)).toEqual({
      endpoint: 'https://tts.example.com',
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      key: undefined,
    });
  });

  test('settings without a speech part have none', async () => {
    expect(await resolveSpeechPart(voice(), credentials)).toBeUndefined();
  });
});

describe('resolveVoiceKey', () => {
  test('uses each host credential and never sends it to another host', async () => {
    const { resolveVoiceKey } = await import('../../../../src/lib/voice/voice-parts.ts');
    const manager = {
      getCredentials: async (id: string) => {
        const keys: Record<string, string> = {
          'voice-transcription:api.openai.com': 'openai-key',
          'voice-transcription:api.deepgram.com': 'deepgram-key',
        };
        return keys[id] ? { type: 'api_key' as const, apiKey: keys[id] } : null;
      },
    };
    const settings = voice();
    for (const endpoint of [
      'https://api.openai.com/v1/audio/transcriptions',
      'wss://api.openai.com/v1/realtime',
      'https://api.openai.com/v1/audio/speech',
    ]) {
      expect(await resolveVoiceKey(settings, new URL(endpoint), manager)).toBe('openai-key');
    }
    expect(
      await resolveVoiceKey(settings, new URL('wss://api.deepgram.com/v1/listen'), manager)
    ).toBe('deepgram-key');
    expect(
      await resolveVoiceKey(settings, new URL('https://other.example/v1'), manager)
    ).toBeUndefined();
  });
});
