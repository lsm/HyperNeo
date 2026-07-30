import type { MessageHub } from '@hyperneo/shared';
import type { SettingsManager } from '../settings-manager';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager';

const VOICE_CREDENTIAL_PROVIDER_ID = 'voice-transcription';

interface VoiceTranscribeRequest {
  audioBase64: string;
  mimeType: 'audio/wav';
}

interface VoiceTranscribeResponse {
  text: string;
}

const TRANSCRIPTION_TIMEOUT_MS = 60_000;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_AUDIO_BYTES / 3) * 4;

export function registerVoiceHandlers(
  messageHub: MessageHub,
  settingsManager: SettingsManager,
  credentialManager?: ProviderCredentialManager
): void {
  messageHub.onRequest<VoiceTranscribeRequest, VoiceTranscribeResponse>(
    'voice.transcribe',
    async (data) => transcribeAudio(settingsManager, data, credentialManager)
  );

  messageHub.onRequest('voice.testConnection', async () =>
    transcribeAudio(
      settingsManager,
      {
        audioBase64: Buffer.from(createSilentWav()).toString('base64'),
        mimeType: 'audio/wav',
      },
      credentialManager
    )
  );
}

async function transcribeAudio(
  settingsManager: SettingsManager,
  data: VoiceTranscribeRequest,
  credentialManager?: ProviderCredentialManager
): Promise<VoiceTranscribeResponse> {
  const voice = settingsManager.getGlobalSettings().voice;
  if (!voice?.enabled) throw new Error('Voice input is disabled');
  if (!voice.endpoint?.trim()) throw new Error('Voice transcription endpoint is required');
  if (!voice.model?.trim()) throw new Error('Voice transcription model is required');
  if (data?.mimeType !== 'audio/wav')
    throw new Error('Voice transcription requires audio/wav input');
  if (!data.audioBase64) throw new Error('Audio data is required');
  if (data.audioBase64.length > MAX_BASE64_LENGTH) {
    throw new Error('Audio data exceeds the 3 MB voice input limit');
  }

  let endpoint: URL;
  try {
    endpoint = new URL(voice.endpoint);
  } catch {
    throw new Error('Voice transcription endpoint must be a valid URL');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('Voice transcription endpoint must use http:// or https://');
  }

  let audio: Uint8Array;
  try {
    audio = Buffer.from(data.audioBase64, 'base64');
  } catch {
    throw new Error('Audio data must be valid base64');
  }
  if (audio.byteLength === 0) throw new Error('Audio data is empty');
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('Audio data exceeds the 3 MB voice input limit');
  }

  const form = new FormData();
  form.append('model', voice.model.trim());
  form.append('file', new Blob([audio], { type: data.mimeType }), 'audio.wav');

  const headers: Record<string, string> = {};
  const apiKey = await resolveApiKey(
    voice.apiKey,
    voice.apiKeyEndpoint,
    endpoint,
    credentialManager
  );
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
      ...(voice.allowInsecureTls ? { tls: { rejectUnauthorized: false } } : {}),
    } as RequestInit & { tls?: { rejectUnauthorized: boolean } });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(normalizeErrorMessage(bodyText, response.status));
    }

    const parsed = parseJson(bodyText);
    if (typeof parsed?.text !== 'string') {
      throw new Error('Transcription response did not include text');
    }
    return { text: parsed.text };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Voice transcription timed out after 60 seconds');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveApiKey(
  legacyApiKey: string | undefined,
  apiKeyEndpoint: string | undefined,
  endpoint: URL,
  credentialManager?: ProviderCredentialManager
): Promise<string | undefined> {
  const trimmedLegacyKey = legacyApiKey?.trim();
  if (trimmedLegacyKey) return trimmedLegacyKey;
  if (!apiKeyEndpoint || endpoint.toString() !== normalizeEndpoint(apiKeyEndpoint))
    return undefined;
  const credentials = await credentialManager?.getCredentials(VOICE_CREDENTIAL_PROVIDER_ID);
  return credentials?.type === 'api_key' ? credentials.apiKey?.trim() : undefined;
}

function normalizeEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).toString();
  } catch {
    return endpoint;
  }
}

function normalizeErrorMessage(bodyText: string, status: number): string {
  const parsed = parseJson(bodyText);
  const message =
    parsed?.error && typeof parsed.error === 'object' && 'message' in parsed.error
      ? parsed.error.message
      : parsed?.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  const trimmed = bodyText.trim();
  if (trimmed) return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
  return `Voice transcription failed with HTTP ${status}`;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function createSilentWav(): Uint8Array {
  const sampleRate = 16_000;
  const samples = sampleRate / 10;
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
