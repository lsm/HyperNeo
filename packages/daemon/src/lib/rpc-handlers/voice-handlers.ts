import { lookup } from 'node:dns/promises';
import type { CallContext, MessageHub } from '@hyperneo/shared';
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
const MAX_CONCURRENT_TRANSCRIPTIONS_PER_CLIENT = 1;
const TRANSCRIPTION_RATE_WINDOW_MS = 60_000;
const MAX_TRANSCRIPTIONS_PER_RATE_WINDOW = 6;
const ALLOWED_PRIVATE_ENDPOINT_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'ai0']);

const activeTranscriptionsByClient = new Map<string, number>();
const transcriptionRateWindowsByClient = new Map<
  string,
  { windowStartedAt: number; count: number }
>();

export function registerVoiceHandlers(
  messageHub: MessageHub,
  settingsManager: SettingsManager,
  credentialManager?: ProviderCredentialManager
): void {
  messageHub.onRequest<VoiceTranscribeRequest, VoiceTranscribeResponse>(
    'voice.transcribe',
    async (data, context) =>
      withVoiceTranscriptionLimits(context, data, () =>
        transcribeAudio(settingsManager, data, credentialManager)
      )
  );

  messageHub.onRequest('voice.testConnection', async (_data, context) => {
    const recording = {
      audioBase64: Buffer.from(createSilentWav()).toString('base64'),
      mimeType: 'audio/wav' as const,
    };
    return withVoiceTranscriptionLimits(context, recording, () =>
      transcribeAudio(settingsManager, recording, credentialManager)
    );
  });
}

async function withVoiceTranscriptionLimits<TResult>(
  context: CallContext | undefined,
  data: VoiceTranscribeRequest,
  run: () => Promise<TResult>
): Promise<TResult> {
  if (data?.mimeType !== 'audio/wav')
    throw new Error('Voice transcription requires audio/wav input');
  if (!data.audioBase64) throw new Error('Audio data is required');
  if (data.audioBase64.length > MAX_BASE64_LENGTH) {
    throw new Error('Audio data exceeds the 3 MB voice input limit');
  }

  const clientKey = context?.clientId ?? context?.sessionId ?? 'global';
  enforceTranscriptionRateLimit(clientKey);
  const activeCount = activeTranscriptionsByClient.get(clientKey) ?? 0;
  if (activeCount >= MAX_CONCURRENT_TRANSCRIPTIONS_PER_CLIENT) {
    throw new Error('Voice transcription is already in progress for this client');
  }

  activeTranscriptionsByClient.set(clientKey, activeCount + 1);
  try {
    return await run();
  } finally {
    const nextCount = (activeTranscriptionsByClient.get(clientKey) ?? 1) - 1;
    if (nextCount <= 0) {
      activeTranscriptionsByClient.delete(clientKey);
    } else {
      activeTranscriptionsByClient.set(clientKey, nextCount);
    }
  }
}

function enforceTranscriptionRateLimit(clientKey: string): void {
  const now = Date.now();
  const current = transcriptionRateWindowsByClient.get(clientKey);
  if (!current || now - current.windowStartedAt >= TRANSCRIPTION_RATE_WINDOW_MS) {
    transcriptionRateWindowsByClient.set(clientKey, { windowStartedAt: now, count: 1 });
    return;
  }
  if (current.count >= MAX_TRANSCRIPTIONS_PER_RATE_WINDOW) {
    throw new Error('Voice transcription rate limit exceeded; please wait before trying again');
  }
  current.count += 1;
}

async function validateTranscriptionEndpoint(endpoint: URL): Promise<void> {
  const host = endpoint.hostname.toLowerCase();
  if (ALLOWED_PRIVATE_ENDPOINT_HOSTS.has(host)) return;
  if (isPrivateNetworkHost(host)) {
    throwPrivateEndpointError();
  }

  const addresses = await lookup(host, { all: true, verbatim: true });
  if (addresses.some((address) => isPrivateNetworkHost(address.address))) {
    throwPrivateEndpointError();
  }
}

function throwPrivateEndpointError(): never {
  throw new Error(
    'Voice transcription endpoint must not target private, loopback, or link-local addresses'
  );
}

function isPrivateNetworkHost(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) {
    return isPrivateNetworkHost(host.slice(1, -1));
  }
  if (host === 'localhost') return true;
  if (
    host === '::1' ||
    host.toLowerCase().startsWith('fe80:') ||
    host.toLowerCase().startsWith('fc')
  ) {
    return true;
  }

  const octets = host.split('.').map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
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
  let endpoint: URL;
  try {
    endpoint = new URL(voice.endpoint);
  } catch {
    throw new Error('Voice transcription endpoint must be a valid URL');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('Voice transcription endpoint must use http:// or https://');
  }
  await validateTranscriptionEndpoint(endpoint);

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
