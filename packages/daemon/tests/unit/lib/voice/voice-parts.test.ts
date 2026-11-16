import { describe, expect, test } from 'bun:test';
import type { VoiceSettings } from '@hyperneo/shared';
import { resolveSpeechPart } from '../../../../src/lib/voice/voice-parts.ts';

const credentials = {
  getCredentials: async () => ({ type: 'api_key' as const, apiKey: 'sk-openai' }),
};
const voice = (speechEndpoint?: string): VoiceSettings => ({
  enabled: true,
  endpoint: 'https://api.openai.com/v1/audio/transcriptions',
  model: 'whisper-1',
  hasApiKey: true,
  apiKeyEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
  ...(speechEndpoint
    ? { speech: { provider: 'openai', endpoint: speechEndpoint, model: 'gpt-4o-mini-tts' } }
    : {}),
});

describe('resolveSpeechPart', () => {
  test('a speech part on the key host gets the same key', async () => {
    expect(await resolveSpeechPart(voice('https://api.openai.com'), credentials)).toEqual({
      endpoint: 'https://api.openai.com',
      model: 'gpt-4o-mini-tts',
      key: 'sk-openai',
    });
  });

  test('a speech part on another host gets no key', async () => {
    expect(await resolveSpeechPart(voice('https://tts.example.com'), credentials)).toEqual({
      endpoint: 'https://tts.example.com',
      model: 'gpt-4o-mini-tts',
      key: undefined,
    });
  });

  test('settings without a speech part have none', async () => {
    expect(await resolveSpeechPart(voice(), credentials)).toBeUndefined();
  });
});
