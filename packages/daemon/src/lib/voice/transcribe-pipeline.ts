import { VOICE_MAX_AUDIO_BYTES } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import { withVoiceCredentialLock } from '../rpc-handlers/voice-credential-lock.ts';
import type { SettingsManager } from '../settings-manager.ts';
import {
  fetchTranscriptionWithRedirects,
  normalizeErrorMessage,
  parseJson,
  readLimitedResponseText,
  withTimeout,
} from './transcribe-fetch.ts';

const VOICE_CREDENTIAL_PROVIDER_ID = 'voice-transcription';
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const CREDENTIAL_LOOKUP_TIMEOUT_MS = 16_000;
const MAX_AUDIO_BYTES = VOICE_MAX_AUDIO_BYTES;
const MAX_BASE64_LENGTH = Math.ceil(MAX_AUDIO_BYTES / 3) * 4;
const MAX_CONCURRENT_TRANSCRIPTIONS_PER_CLIENT = 1;
const MAX_CONCURRENT_TRANSCRIPTIONS_DAEMON_WIDE = 4;
const TRANSCRIPTION_RATE_WINDOW_MS = 60_000;
const MAX_TRANSCRIPTIONS_PER_RATE_WINDOW = 6;
const MAX_TRANSCRIPTIONS_PER_DAEMON_RATE_WINDOW = 20;
const RATE_LIMIT_MAP_PRUNE_THRESHOLD = 256;

export type VoiceTranscribeOutcome =
  | { action: 'transcribed'; text: string }
  | { action: 'denied'; message: string }
  | { action: 'failed'; error: string };

export interface VoiceTranscribeRateWindow {
  windowStartedAt: number;
  count: number;
}

export interface VoiceTranscribeLimiters {
  activeByClient: Map<string, number>;
  rateWindowsByClient: Map<string, VoiceTranscribeRateWindow>;
  daemonActive: { count: number };
  daemonRateWindow: VoiceTranscribeRateWindow;
}

export function createVoiceTranscribeLimiters(): VoiceTranscribeLimiters {
  return {
    activeByClient: new Map(),
    rateWindowsByClient: new Map(),
    daemonActive: { count: 0 },
    daemonRateWindow: { windowStartedAt: 0, count: 0 },
  };
}

export interface VoiceTranscribeDeps {
  settingsManager: Pick<SettingsManager, 'getGlobalSettings'>;
  credentialManager?: Pick<ProviderCredentialManager, 'getCredentials'>;
  limiters: VoiceTranscribeLimiters;
  now?: () => number;
}

interface VoiceTranscribeAdmission {
  release?: () => void;
}

export interface VoiceTranscribeInput {
  data: { audioBase64: string; mimeType: string };
  context?: { clientId?: string; sessionId?: string };
  deps: VoiceTranscribeDeps;
}

interface VoiceTranscribeCtx extends VoiceTranscribeInput {
  controller: AbortController;
  admission: VoiceTranscribeAdmission;
  clientKey: string;
  endpoint?: URL;
  model?: string;
  allowPrivateNetwork?: boolean;
  allowInsecureTls?: boolean;
  audio?: Uint8Array;
  apiKey?: string;
  headers?: Record<string, string>;
  form?: FormData;
  response?: Response;
  bodyText?: string;
  outcome?: VoiceTranscribeOutcome;
}

function denied(message: string): VoiceTranscribeOutcome {
  return { action: 'denied', message };
}

function failed(error: string): VoiceTranscribeOutcome {
  return { action: 'failed', error };
}

function currentTime(deps: VoiceTranscribeDeps): number {
  return deps.now?.() ?? Date.now();
}

function withinWindow(
  window: VoiceTranscribeRateWindow | undefined,
  now: number,
  max: number
): boolean {
  if (!window || now - window.windowStartedAt >= TRANSCRIPTION_RATE_WINDOW_MS) return true;
  return window.count < max;
}

function commitWindow(
  window: VoiceTranscribeRateWindow | undefined,
  now: number
): VoiceTranscribeRateWindow {
  if (!window || now - window.windowStartedAt >= TRANSCRIPTION_RATE_WINDOW_MS) {
    return { windowStartedAt: now, count: 1 };
  }
  return { windowStartedAt: window.windowStartedAt, count: window.count + 1 };
}

function pruneExpiredRateWindows(limiters: VoiceTranscribeLimiters, now: number): void {
  for (const [key, window] of limiters.rateWindowsByClient) {
    if (now - window.windowStartedAt >= TRANSCRIPTION_RATE_WINDOW_MS) {
      limiters.rateWindowsByClient.delete(key);
    }
  }
}

function releaseTranscriptionAdmission(limiters: VoiceTranscribeLimiters, clientKey: string): void {
  limiters.daemonActive.count = Math.max(0, limiters.daemonActive.count - 1);
  const nextCount = (limiters.activeByClient.get(clientKey) ?? 1) - 1;
  if (nextCount <= 0) {
    limiters.activeByClient.delete(clientKey);
  } else {
    limiters.activeByClient.set(clientKey, nextCount);
  }
}

function validateAudioInput(ctx: VoiceTranscribeCtx): VoiceTranscribeCtx {
  if (ctx.data?.mimeType !== 'audio/wav') {
    return { ...ctx, outcome: denied('Voice transcription requires audio/wav input') };
  }
  if (!ctx.data.audioBase64) return { ...ctx, outcome: denied('Audio data is required') };
  if (ctx.data.audioBase64.length > MAX_BASE64_LENGTH) {
    return { ...ctx, outcome: denied('Audio data exceeds the 10 MB voice input limit') };
  }
  const decodable =
    /^[A-Za-z0-9+/]*={0,2}$/.test(ctx.data.audioBase64) && ctx.data.audioBase64.length % 4 === 0;
  if (!decodable) return { ...ctx, outcome: denied('Audio data must be valid base64') };
  return ctx;
}

function admitDaemonRateWindow(ctx: VoiceTranscribeCtx): VoiceTranscribeCtx {
  const { limiters } = ctx.deps;
  const now = currentTime(ctx.deps);
  if (limiters.rateWindowsByClient.size > RATE_LIMIT_MAP_PRUNE_THRESHOLD) {
    pruneExpiredRateWindows(limiters, now);
  }
  if (withinWindow(limiters.daemonRateWindow, now, MAX_TRANSCRIPTIONS_PER_DAEMON_RATE_WINDOW)) {
    return ctx;
  }
  return {
    ...ctx,
    outcome: denied(
      'Voice transcription daemon-wide rate limit exceeded; please wait before trying again'
    ),
  };
}

function admitDaemonConcurrency(ctx: VoiceTranscribeCtx): VoiceTranscribeCtx {
  if (ctx.deps.limiters.daemonActive.count < MAX_CONCURRENT_TRANSCRIPTIONS_DAEMON_WIDE) return ctx;
  return {
    ...ctx,
    outcome: denied('Too many voice transcription requests are already in progress'),
  };
}

function admitClientRateWindow(ctx: VoiceTranscribeCtx): VoiceTranscribeCtx {
  const window = ctx.deps.limiters.rateWindowsByClient.get(ctx.clientKey);
  if (withinWindow(window, currentTime(ctx.deps), MAX_TRANSCRIPTIONS_PER_RATE_WINDOW)) return ctx;
  return {
    ...ctx,
    outcome: denied('Voice transcription rate limit exceeded; please wait before trying again'),
  };
}

function admitClientConcurrency(ctx: VoiceTranscribeCtx): VoiceTranscribeCtx {
  if (
    (ctx.deps.limiters.activeByClient.get(ctx.clientKey) ?? 0) <
    MAX_CONCURRENT_TRANSCRIPTIONS_PER_CLIENT
  ) {
    return ctx;
  }
  return { ...ctx, outcome: denied('Voice transcription is already in progress for this client') };
}

function commitTranscriptionAdmission(ctx: VoiceTranscribeCtx): VoiceTranscribeCtx {
  const { limiters } = ctx.deps;
  const now = currentTime(ctx.deps);
  limiters.daemonRateWindow = commitWindow(limiters.daemonRateWindow, now);
  limiters.rateWindowsByClient.set(
    ctx.clientKey,
    commitWindow(limiters.rateWindowsByClient.get(ctx.clientKey), now)
  );
  limiters.activeByClient.set(ctx.clientKey, (limiters.activeByClient.get(ctx.clientKey) ?? 0) + 1);
  limiters.daemonActive.count += 1;
  ctx.admission.release = () => releaseTranscriptionAdmission(limiters, ctx.clientKey);
  return ctx;
}

function resolveTranscriptionEndpoint(ctx: VoiceTranscribeCtx): VoiceTranscribeCtx {
  const voice = ctx.deps.settingsManager.getGlobalSettings().voice;
  if (!voice?.enabled) return { ...ctx, outcome: denied('Voice input is disabled') };
  if (!voice.endpoint?.trim()) {
    return { ...ctx, outcome: denied('Voice transcription endpoint is required') };
  }
  if (!voice.model?.trim()) {
    return { ...ctx, outcome: denied('Voice transcription model is required') };
  }
  let endpoint: URL;
  try {
    endpoint = new URL(voice.endpoint);
  } catch {
    return { ...ctx, outcome: denied('Voice transcription endpoint must be a valid URL') };
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    return {
      ...ctx,
      outcome: denied('Voice transcription endpoint must use http:// or https://'),
    };
  }
  const audio = Buffer.from(ctx.data.audioBase64, 'base64');
  if (audio.byteLength === 0) return { ...ctx, outcome: denied('Audio data is empty') };
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return { ...ctx, outcome: denied('Audio data exceeds the 10 MB voice input limit') };
  }
  return {
    ...ctx,
    endpoint,
    model: voice.model.trim(),
    allowPrivateNetwork: voice.allowPrivateNetwork ?? false,
    allowInsecureTls: voice.allowInsecureTls ?? false,
    audio,
  };
}

async function resolveApiKey(
  legacyApiKey: string | undefined,
  apiKeyEndpoint: string | undefined,
  endpoint: URL,
  credentialManager?: Pick<ProviderCredentialManager, 'getCredentials'>
): Promise<string | undefined> {
  const trimmedLegacyKey = legacyApiKey?.trim();
  if (trimmedLegacyKey) return trimmedLegacyKey;
  if (!apiKeyEndpoint || endpoint.toString() !== normalizeEndpoint(apiKeyEndpoint)) {
    return undefined;
  }
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

async function acquireTranscriptionCredentials(
  ctx: VoiceTranscribeCtx
): Promise<VoiceTranscribeCtx> {
  let endpoint = ctx.endpoint!;
  let model = ctx.model!;
  let allowPrivateNetwork = ctx.allowPrivateNetwork!;
  let allowInsecureTls = ctx.allowInsecureTls!;
  const key = await withVoiceCredentialLock(async () => {
    const liveVoice = ctx.deps.settingsManager.getGlobalSettings().voice;
    if (liveVoice?.endpoint) {
      try {
        const liveEndpoint = new URL(liveVoice.endpoint);
        if (liveEndpoint.protocol === 'http:' || liveEndpoint.protocol === 'https:') {
          endpoint = liveEndpoint;
        }
      } catch {}
      allowPrivateNetwork = liveVoice.allowPrivateNetwork ?? false;
      allowInsecureTls = liveVoice.allowInsecureTls ?? false;
      model = liveVoice.model?.trim() || model;
    }
    return withTimeout(
      resolveApiKey(
        liveVoice?.apiKey,
        liveVoice?.apiKeyEndpoint,
        endpoint,
        ctx.deps.credentialManager
      ),
      CREDENTIAL_LOOKUP_TIMEOUT_MS,
      'Voice transcription credential lookup timed out',
      ctx.controller.signal
    );
  }, ctx.controller.signal);
  return { ...ctx, apiKey: key, model, endpoint, allowPrivateNetwork, allowInsecureTls };
}

function buildTranscriptionRequest(ctx: VoiceTranscribeCtx): VoiceTranscribeCtx {
  const headers: Record<string, string> = {};
  if (ctx.apiKey && ctx.endpoint!.protocol !== 'https:') {
    return {
      ...ctx,
      outcome: denied(
        'Voice transcription API keys are only sent over HTTPS. Use an HTTPS endpoint or remove the API key.'
      ),
    };
  }
  if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
  const form = new FormData();
  form.append('model', ctx.model!);
  form.append('file', new Blob([ctx.audio!], { type: ctx.data.mimeType }), 'audio.wav');
  return { ...ctx, headers, form };
}

async function fetchTranscription(ctx: VoiceTranscribeCtx): Promise<VoiceTranscribeCtx> {
  const response = await fetchTranscriptionWithRedirects(
    ctx.endpoint!,
    ctx.headers!,
    ctx.form!,
    ctx.allowPrivateNetwork!,
    ctx.allowInsecureTls!,
    ctx.controller.signal
  );
  return { ...ctx, response };
}

async function readTranscriptionBody(ctx: VoiceTranscribeCtx): Promise<VoiceTranscribeCtx> {
  return { ...ctx, bodyText: await readLimitedResponseText(ctx.response!) };
}

function parseTranscriptionText(ctx: VoiceTranscribeCtx): VoiceTranscribeCtx {
  if (!ctx.response!.ok) {
    return { ...ctx, outcome: failed(normalizeErrorMessage(ctx.bodyText!, ctx.response!.status)) };
  }
  const text = parseJson(ctx.bodyText!)?.text;
  if (typeof text !== 'string') {
    return { ...ctx, outcome: failed('Transcription response did not include text') };
  }
  return { ...ctx, outcome: { action: 'transcribed', text } };
}

const runVoiceTranscribePipeline = (
  superpipe<{
    hasOutcome: (ctx: VoiceTranscribeCtx) => boolean;
  }>({
    hasOutcome: (ctx) => ctx.outcome !== undefined,
  })('voice-transcribe') as PipelineAPI
)
  .input(['ctx'])
  .pipe(validateAudioInput, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(admitDaemonRateWindow, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(admitDaemonConcurrency, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(admitClientRateWindow, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(admitClientConcurrency, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(commitTranscriptionAdmission, 'ctx', 'ctx')
  .pipe(resolveTranscriptionEndpoint, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(acquireTranscriptionCredentials, 'ctx', 'ctx')
  .pipe(buildTranscriptionRequest, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(fetchTranscription, 'ctx', 'ctx')
  .pipe(readTranscriptionBody, 'ctx', 'ctx')
  .pipe(parseTranscriptionText, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: VoiceTranscribeCtx) => Promise<VoiceTranscribeCtx>;

export async function runVoiceTranscribe(
  input: VoiceTranscribeInput
): Promise<VoiceTranscribeOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
  const admission: VoiceTranscribeAdmission = {};
  try {
    const ctx = await runVoiceTranscribePipeline({
      data: input.data,
      context: input.context,
      clientKey: input.context?.clientId ?? input.context?.sessionId ?? 'global',
      deps: input.deps,
      controller,
      admission,
    });
    return ctx.outcome ?? failed('Voice transcription produced no outcome');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return failed('Voice transcription timed out after 60 seconds');
    }
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
    admission.release?.();
  }
}
