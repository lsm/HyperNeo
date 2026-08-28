import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_TRANSCRIPTION_REDIRECTS = 3;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 256 * 1024;
const RESOLUTION_TIMEOUT_MS = 10_000;

export async function fetchTranscriptionWithRedirects(
  endpoint: URL,
  headers: Record<string, string>,
  form: FormData,
  allowPrivateNetwork: boolean,
  allowInsecureTls: boolean,
  signal: AbortSignal
): Promise<Response> {
  let logicalEndpoint = endpoint;
  let candidates = await resolveTranscriptionEndpoint(
    endpoint,
    allowPrivateNetwork,
    allowInsecureTls,
    signal
  );
  let requestHeaders = { ...headers };
  let requestMethod: string = 'POST';
  let requestBody: FormData | undefined = form;
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_TRANSCRIPTION_REDIRECTS; hop++) {
    response = undefined;
    let fetchError: unknown;
    for (const candidate of candidates) {
      try {
        response = await fetch(candidate.toString(), {
          method: requestMethod,
          headers: { ...requestHeaders, Host: logicalEndpoint.host },
          body: requestBody,
          redirect: 'manual',
          signal,
          tls: {
            rejectUnauthorized: !(allowInsecureTls && logicalEndpoint.host === endpoint.host),
            serverName: stripBrackets(logicalEndpoint.hostname),
          },
        } as RequestInit & { tls?: { rejectUnauthorized: boolean; serverName: string } });
        break;
      } catch (error) {
        if (signal.aborted) throw error;
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
    } catch {}
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
    if (logicalEndpoint.protocol === 'https:' && redirectTarget.protocol === 'http:') {
      throw new Error('Voice transcription cannot follow an HTTPS-to-HTTP redirect');
    }
    if (response.status !== 307 && response.status !== 308) {
      requestMethod = 'GET';
      requestBody = undefined;
    }
    logicalEndpoint = redirectTarget;
    candidates = await resolveTranscriptionEndpoint(
      redirectTarget,
      allowPrivateNetwork,
      allowInsecureTls && redirectTarget.host === endpoint.host,
      signal
    );
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
  return response;
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

  const ipHost = stripBrackets(host);
  if (isIP(ipHost)) return [stripUserInfo(endpoint)];

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

  if (endpoint.protocol === 'https:' && !allowInsecureTls) {
    return [stripUserInfo(endpoint)];
  }

  const firstAddress = publicAddresses[0]!;
  const pinnedEndpoint = stripUserInfo(endpoint);
  pinnedEndpoint.hostname = firstAddress.includes(':') ? `[${firstAddress}]` : firstAddress;
  return [pinnedEndpoint];
}

function stripUserInfo(endpoint: URL): URL {
  if (!endpoint.username && !endpoint.password) return new URL(endpoint);
  const sanitized = new URL(endpoint);
  sanitized.username = '';
  sanitized.password = '';
  return sanitized;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
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

    const firstHextet = Number.parseInt(normalized.split(':')[0] ?? '', 16);
    return (
      normalized === '::' ||
      normalized === '::1' ||
      (Number.isInteger(firstHextet) && (firstHextet & 0xffc0) === 0xfe80) ||
      (Number.isInteger(firstHextet) && (firstHextet & 0xffc0) === 0xfec0) ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('64:ff9b:') ||
      normalized.startsWith('ff')
    );
  }

  const octets = host.split('.').map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && second >= 18 && second <= 19) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

export async function readLimitedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_TRANSCRIPTION_RESPONSE_BYTES) {
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

export function normalizeErrorMessage(bodyText: string, status: number): string {
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

export function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
