import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
const MAX_CONCURRENT_TRANSCRIPTIONS_DAEMON_WIDE = 4;
const TRANSCRIPTION_RATE_WINDOW_MS = 60_000;
const MAX_TRANSCRIPTIONS_PER_RATE_WINDOW = 6;
const MAX_TRANSCRIPTIONS_PER_DAEMON_RATE_WINDOW = 20;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 256 * 1024;
const MAX_TRANSCRIPTION_REDIRECTS = 3;
const RATE_LIMIT_MAP_PRUNE_THRESHOLD = 256;
const RESOLUTION_TIMEOUT_MS = 10_000;

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
    throw new Error('Audio data exceeds the 3 MB voice input limit');
  }

  const clientKey = context?.clientId ?? context?.sessionId ?? 'global';
  // Run every admission check WITHOUT committing the rate counters, then commit
  // only after all pass — otherwise one client's rejected calls could exhaust
  // the daemon-wide quota and starve every other client.
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

  // All admission checks passed — commit the rate/concurrency counters.
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

// Check-only helpers: return whether a request is admissible WITHOUT mutating
// the counters, so a later admission failure does not charge the quota.
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

async function resolveTranscriptionEndpoint(
  endpoint: URL,
  allowPrivateNetwork: boolean,
  allowInsecureTls: boolean,
  signal?: AbortSignal
): Promise<URL[]> {
  if (allowPrivateNetwork) return [stripUserInfo(endpoint)];

  const host = endpoint.hostname.toLowerCase();
  if (isPrivateNetworkHost(host)) {
    throwPrivateEndpointError();
  }

  // `URL.hostname` keeps brackets around IPv6 literals; strip them for IP
  // classification and lookup so a public IPv6 endpoint is not misclassified.
  const ipHost = stripBrackets(host);
  if (isIP(ipHost)) return [stripUserInfo(endpoint)];

  // Bound DNS resolution so a stalled resolver cannot hold the request's
  // active-transcription slots beyond the deadline.
  const addresses = await withTimeout(
    lookup(ipHost, { all: true, verbatim: true }),
    RESOLUTION_TIMEOUT_MS,
    'Voice transcription endpoint resolution timed out',
    signal
  );
  const publicAddresses = addresses
    .map((address) => address.address)
    .filter((address) => !isPrivateNetworkHost(address));
  if (publicAddresses.length === 0) throwPrivateEndpointError();

  // For HTTPS with certificate verification enabled, fetch the logical hostname
  // so TLS validates the certificate against it (pinning a raw IP would make a
  // standard hostname certificate invalid). Rebinding to an internal host is
  // blocked because an internal service cannot present a valid certificate for
  // the public hostname. When verification is disabled (allowInsecureTls), that
  // anchor is gone, so pin the validated address to close DNS rebinding.
  if (endpoint.protocol === 'https:' && !allowInsecureTls) {
    return [stripUserInfo(endpoint)];
  }

  // For plaintext HTTP there is no certificate to anchor the hostname, so pin
  // the validated public address(es) to close DNS rebinding; keep every public
  // address for dual-stack/round-robin fallback.
  return publicAddresses.map((address) => {
    const pinnedEndpoint = stripUserInfo(endpoint);
    // Bare IPv6 literals must be bracketed when assigned to `URL.hostname`;
    // otherwise the assignment is ignored and the original host is re-resolved.
    pinnedEndpoint.hostname = address.includes(':') ? `[${address}]` : address;
    return pinnedEndpoint;
  });
}

// Drop embedded userinfo so the runtime cannot derive an implicit Basic
// Authorization header that would bypass the HTTPS-only credential guard.
function stripUserInfo(endpoint: URL): URL {
  if (!endpoint.username && !endpoint.password) return new URL(endpoint);
  const sanitized = new URL(endpoint);
  sanitized.username = '';
  sanitized.password = '';
  return sanitized;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  // If the overall request deadline already elapsed, fail fast rather than
  // starting another bounded lookup that would outlive the deadline.
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      })
    : null;
  try {
    return await Promise.race(
      abortPromise ? [promise, timeoutPromise, abortPromise] : [promise, timeoutPromise]
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function throwPrivateEndpointError(): never {
  throw new Error(
    'Voice transcription endpoint targets a private, loopback, or link-local address. Enable private/LAN endpoints in Voice settings for trusted local ASR backends.'
  );
}

function isPrivateNetworkHost(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) {
    return isPrivateNetworkHost(host.slice(1, -1));
  }
  if (host === 'localhost') return true;

  const normalized = host.toLowerCase();
  // IPv6-specific ranges only apply to IPv6 literals — never to DNS names,
  // so a public hostname beginning with "fc"/"fd" is not falsely rejected.
  if (normalized.includes(':')) {
    if (normalized.startsWith('::ffff:')) {
      const mappedAddress = normalized.slice('::ffff:'.length);
      if (mappedAddress.includes('.')) return isPrivateNetworkHost(mappedAddress);
      const parts = mappedAddress.split(':');
      if (parts.length >= 2) {
        const high = Number.parseInt(parts.at(-2) ?? '', 16);
        const low = Number.parseInt(parts.at(-1) ?? '', 16);
        if (Number.isInteger(high) && Number.isInteger(low)) {
          return isPrivateNetworkHost(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
        }
      }
    }

    // Link-local is fe80::/10 (fe80 through febf), not just the fe80: prefix.
    // fec0::/10 is the deprecated site-local range (still routed on some nets).
    const firstHextet = Number.parseInt(normalized.split(':')[0] ?? '', 16);
    return (
      normalized === '::' ||
      normalized === '::1' ||
      (Number.isInteger(firstHextet) && (firstHextet & 0xffc0) === 0xfe80) ||
      (Number.isInteger(firstHextet) && (firstHextet & 0xffc0) === 0xfec0) ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('64:ff9b:')
    );
  }

  const octets = host.split('.').map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second, third, fourth] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && second >= 18 && second <= 19) ||
    (first === 255 && second === 255 && third === 255 && fourth === 255)
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
  const allowPrivateNetwork = voice.allowPrivateNetwork ?? false;
  const allowInsecureTls = voice.allowInsecureTls ?? false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
  try {
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
    const apiKey = await withTimeout(
      resolveApiKey(voice.apiKey, voice.apiKeyEndpoint, endpoint, credentialManager),
      RESOLUTION_TIMEOUT_MS,
      'Voice transcription credential lookup timed out'
    );
    if (apiKey) {
      // Never transmit the stored bearer credential over plaintext HTTP.
      if (endpoint.protocol !== 'https:') {
        throw new Error(
          'Voice transcription API keys are only sent over HTTPS. Use an HTTPS endpoint or remove the API key.'
        );
      }
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // Follow redirects manually so each Location target is re-validated and
    // pinned through resolveTranscriptionEndpoint — a public endpoint cannot
    // 3xx the daemon onto a private/internal host. DNS is resolved up front so
    // the deadline (controller) covers endpoint resolution too.
    let logicalEndpoint = endpoint;
    let candidates = await resolveTranscriptionEndpoint(
      endpoint,
      allowPrivateNetwork,
      allowInsecureTls,
      controller.signal
    );
    let requestHeaders = { ...headers };
    let requestMethod: string = 'POST';
    let requestBody: FormData | undefined = form;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_TRANSCRIPTION_REDIRECTS; hop++) {
      // Only accept a response obtained on this hop, so a redirect whose
      // destination fails at the network layer surfaces fetchError instead of
      // reprocessing the previous 3xx.
      response = undefined;
      // Try each validated pinned address; fall back to the next on a network
      // error so dual-stack/round-robin resolutions survive a dead record.
      let fetchError: unknown;
      for (const candidate of candidates) {
        try {
          response = await fetch(candidate.toString(), {
            method: requestMethod,
            headers: { ...requestHeaders, Host: logicalEndpoint.host },
            body: requestBody,
            redirect: 'manual',
            signal: controller.signal,
            tls: {
              // Insecure TLS is only for the trusted configured host; restore
              // certificate verification after any cross-host redirect.
              rejectUnauthorized: !(allowInsecureTls && logicalEndpoint.host === endpoint.host),
              serverName: stripBrackets(logicalEndpoint.hostname),
            },
          } as RequestInit & { tls?: { rejectUnauthorized: boolean; serverName: string } });
          break;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          fetchError = error;
        }
      }
      if (!response) {
        throw fetchError instanceof Error
          ? fetchError
          : new Error('Voice transcription request failed');
      }

      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) break;
      try {
        await response.body?.cancel();
      } catch {
        // Ignore body cancellation failures.
      }
      if (hop === MAX_TRANSCRIPTION_REDIRECTS) {
        throw new Error('Voice transcription redirected too many times');
      }

      let redirectTarget: URL;
      try {
        redirectTarget = new URL(location, logicalEndpoint);
      } catch {
        throw new Error('Voice transcription returned an invalid redirect');
      }
      if (redirectTarget.protocol !== 'http:' && redirectTarget.protocol !== 'https:') {
        throw new Error('Voice transcription redirect must use http:// or https://');
      }
      // Never follow an HTTPS-to-HTTP downgrade: a 307/308 would replay the
      // recorded audio (and any retained body) over plaintext.
      if (logicalEndpoint.protocol === 'https:' && redirectTarget.protocol === 'http:') {
        throw new Error('Voice transcription cannot follow an HTTPS-to-HTTP redirect');
      }
      // 303 (and legacy 301/302) switch to a bodyless GET; 307/308 preserve the
      // method and body.
      if (response.status !== 307 && response.status !== 308) {
        requestMethod = 'GET';
        requestBody = undefined;
      }
      logicalEndpoint = redirectTarget;
      candidates = await resolveTranscriptionEndpoint(
        redirectTarget,
        allowPrivateNetwork,
        allowInsecureTls,
        controller.signal
      );
      // Never forward the stored API key over plaintext HTTP or to a different host.
      if (
        requestHeaders.Authorization &&
        (redirectTarget.protocol !== 'https:' || redirectTarget.host !== endpoint.host)
      ) {
        requestHeaders = { ...requestHeaders };
        delete requestHeaders.Authorization;
      }
    }

    if (!response) {
      throw new Error('Voice transcription produced no response');
    }
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

async function readLimitedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_TRANSCRIPTION_RESPONSE_BYTES) {
    // Cancel the transfer so a misbehaving backend cannot keep it alive.
    await response.body?.cancel().catch(() => {});
    throw new Error('Voice transcription response exceeds the 256 KB limit');
  }

  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_TRANSCRIPTION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Voice transcription response exceeds the 256 KB limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
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
