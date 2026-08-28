import type { CallContext, MessageHub } from '@hyperneo/shared';
import { VOICE_MAX_AUDIO_BYTES } from '@hyperneo/shared';
import type { SettingsManager } from '../settings-manager.ts';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import {
  fetchTranscriptionWithRedirects,
  normalizeErrorMessage,
  parseJson,
  readLimitedResponseText,
  withTimeout,
} from '../voice/transcribe-fetch.ts';
import { withVoiceCredentialLock } from './voice-credential-lock.ts';

const VOICE_CREDENTIAL_PROVIDER_ID = 'voice-transcription';

interface VoiceTranscribeRequest {
  audioBase64: string;
  mimeType: 'audio/wav';
}

interface VoiceTranscribeResponse {
  text: string;
}

const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = VOICE_MAX_AUDIO_BYTES;
const MAX_BASE64_LENGTH = Math.ceil(MAX_AUDIO_BYTES / 3) * 4;
const MAX_CONCURRENT_TRANSCRIPTIONS_PER_CLIENT = 1;
const MAX_CONCURRENT_TRANSCRIPTIONS_DAEMON_WIDE = 4;
const TRANSCRIPTION_RATE_WINDOW_MS = 60_000;
const MAX_TRANSCRIPTIONS_PER_RATE_WINDOW = 6;
const MAX_TRANSCRIPTIONS_PER_DAEMON_RATE_WINDOW = 20;
const RATE_LIMIT_MAP_PRUNE_THRESHOLD = 256;

const activeTranscriptionsByClient = new Map<string, number>();
const transcriptionRateWindowsByClient = new Map<
  string,
  { windowStartedAt: number; count: number }
>();
let activeTranscriptionsDaemonWide = 0;
let daemonRateWindow = { windowStartedAt: 0, count: 0 };

export function resetVoiceTranscriptionLimitsForTests(): void {
  activeTranscriptionsByClient.clear();
  transcriptionRateWindowsByClient.clear();
  activeTranscriptionsDaemonWide = 0;
  daemonRateWindow = { windowStartedAt: 0, count: 0 };
}

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
    throw new Error('Audio data exceeds the 10 MB voice input limit');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data.audioBase64) || data.audioBase64.length % 4 !== 0) {
    throw new Error('Audio data must be valid base64');
  }

  const clientKey = context?.clientId ?? context?.sessionId ?? 'global';
  if (transcriptionRateWindowsByClient.size > RATE_LIMIT_MAP_PRUNE_THRESHOLD) {
    pruneExpiredRateWindows(Date.now());
  }
  if (!withinDaemonRateLimit()) {
    throw new Error(
      'Voice transcription daemon-wide rate limit exceeded; please wait before trying again'
    );
  }
  if (activeTranscriptionsDaemonWide >= MAX_CONCURRENT_TRANSCRIPTIONS_DAEMON_WIDE) {
    throw new Error('Too many voice transcription requests are already in progress');
  }
  const perClientWindow = transcriptionRateWindowsByClient.get(clientKey);
  if (!withinClientRateLimit(perClientWindow)) {
    throw new Error('Voice transcription rate limit exceeded; please wait before trying again');
  }
  const activeCount = activeTranscriptionsByClient.get(clientKey) ?? 0;
  if (activeCount >= MAX_CONCURRENT_TRANSCRIPTIONS_PER_CLIENT) {
    throw new Error('Voice transcription is already in progress for this client');
  }

  commitDaemonRateLimit();
  commitClientRateLimit(perClientWindow, clientKey);
  activeTranscriptionsByClient.set(clientKey, activeCount + 1);
  activeTranscriptionsDaemonWide += 1;
  try {
    return await run();
  } finally {
    activeTranscriptionsDaemonWide = Math.max(0, activeTranscriptionsDaemonWide - 1);
    const nextCount = (activeTranscriptionsByClient.get(clientKey) ?? 1) - 1;
    if (nextCount <= 0) {
      activeTranscriptionsByClient.delete(clientKey);
    } else {
      activeTranscriptionsByClient.set(clientKey, nextCount);
    }
  }
}

function pruneExpiredRateWindows(now: number): void {
  for (const [key, window] of transcriptionRateWindowsByClient) {
    if (now - window.windowStartedAt >= TRANSCRIPTION_RATE_WINDOW_MS) {
      transcriptionRateWindowsByClient.delete(key);
    }
  }
}

function withinDaemonRateLimit(): boolean {
  const now = Date.now();
  if (now - daemonRateWindow.windowStartedAt >= TRANSCRIPTION_RATE_WINDOW_MS) return true;
  return daemonRateWindow.count < MAX_TRANSCRIPTIONS_PER_DAEMON_RATE_WINDOW;
}

function commitDaemonRateLimit(): void {
  const now = Date.now();
  if (now - daemonRateWindow.windowStartedAt >= TRANSCRIPTION_RATE_WINDOW_MS) {
    daemonRateWindow = { windowStartedAt: now, count: 1 };
  } else {
    daemonRateWindow.count += 1;
  }
}

function withinClientRateLimit(
  window: { windowStartedAt: number; count: number } | undefined
): boolean {
  const now = Date.now();
  if (!window || now - window.windowStartedAt >= TRANSCRIPTION_RATE_WINDOW_MS) return true;
  return window.count < MAX_TRANSCRIPTIONS_PER_RATE_WINDOW;
}

function commitClientRateLimit(
  window: { windowStartedAt: number; count: number } | undefined,
  clientKey: string
): void {
  const now = Date.now();
  if (!window || now - window.windowStartedAt >= TRANSCRIPTION_RATE_WINDOW_MS) {
    transcriptionRateWindowsByClient.set(clientKey, { windowStartedAt: now, count: 1 });
  } else {
    window.count += 1;
  }
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
  let allowPrivateNetwork = voice.allowPrivateNetwork ?? false;
  let allowInsecureTls = voice.allowInsecureTls ?? false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
  try {
    let audio: Uint8Array;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data.audioBase64) || data.audioBase64.length % 4 !== 0) {
      throw new Error('Audio data must be valid base64');
    }
    try {
      audio = Buffer.from(data.audioBase64, 'base64');
    } catch {
      throw new Error('Audio data must be valid base64');
    }
    if (audio.byteLength === 0) throw new Error('Audio data is empty');
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      throw new Error('Audio data exceeds the 10 MB voice input limit');
    }

    const headers: Record<string, string> = {};
    const credentialSnapshot = await withVoiceCredentialLock(async () => {
      const liveVoice = settingsManager.getGlobalSettings().voice;
      let liveModel = voice.model.trim();
      if (liveVoice?.endpoint) {
        try {
          const liveEndpoint = new URL(liveVoice.endpoint);
          if (liveEndpoint.protocol === 'http:' || liveEndpoint.protocol === 'https:') {
            endpoint = liveEndpoint;
          }
        } catch {}
        allowPrivateNetwork = liveVoice.allowPrivateNetwork ?? false;
        allowInsecureTls = liveVoice.allowInsecureTls ?? false;
        liveModel = liveVoice.model?.trim() || liveModel;
      }
      const key = await withTimeout(
        resolveApiKey(liveVoice?.apiKey, liveVoice?.apiKeyEndpoint, endpoint, credentialManager),
        16_000,
        'Voice transcription credential lookup timed out',
        controller.signal
      );
      return { key, model: liveModel };
    }, controller.signal);
    const apiKey = credentialSnapshot.key;

    const form = new FormData();
    form.append('model', credentialSnapshot.model);
    form.append('file', new Blob([audio], { type: data.mimeType }), 'audio.wav');
    if (apiKey) {
      if (endpoint.protocol !== 'https:') {
        throw new Error(
          'Voice transcription API keys are only sent over HTTPS. Use an HTTPS endpoint or remove the API key.'
        );
      }
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetchTranscriptionWithRedirects(
      endpoint,
      headers,
      form,
      allowPrivateNetwork,
      allowInsecureTls,
      controller.signal
    );
    const bodyText = await readLimitedResponseText(response);
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
