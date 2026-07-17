/**
 * Credential probe helpers used by provider health checks.
 *
 * The RPC handlers `providers.test` and `providers.healthCheck` rely on
 * `provider.getModels()` to detect broken credentials: if the call throws,
 * the provider is marked `unhealthy`. Providers that return a hardcoded
 * static model list without ever hitting the upstream API never throw on
 * auth failure, so a key that is present but invalid still reports healthy.
 *
 * These helpers give such providers a small, fast, network-backed probe they
 * can call from `getModels()` (or `isAvailable()`) before returning their
 * static catalogue. A failed probe throws a descriptive error so the RPC
 * handler maps it to `unhealthy`.
 *
 * Design constraints (see task #612):
 *   - Timeout at 5 seconds.
 *   - Prefer a lightweight `/models` listing; otherwise send a minimal
 *     `/v1/messages` request with `max_tokens: 1` so we never burn real
 *     completion tokens.
 *   - Map 401/403, non-2xx, and network errors to clear error strings.
 */

/** Default probe timeout. Can be overridden per-call. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Normalise a base URL by trimming whitespace and removing trailing slashes
 * so we can safely append path segments.
 */
export function normalizeBaseUrlForProbe(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * Result of a probe attempt. `ok` means the credentials are usable upstream.
 * Errors are communicated by throwing — callers should let the exception
 * propagate so the RPC handler maps it to `unhealthy`.
 */
export interface AnthropicCompatProbeOptions {
  /** Anthropic-compatible base URL (e.g. `https://api.kimi.com/coding`). */
  baseUrl: string;
  /** API key to verify. */
  apiKey: string;
  /** Model ID to send in the minimal messages payload. */
  model: string;
  /** Provider display name used in error messages (e.g. "Kimi"). */
  providerName: string;
  /** Optional fetch override (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Probe timeout in milliseconds. Defaults to 5000. */
  timeoutMs?: number;
  /**
   * Optional thinking configuration for models that require it (e.g. Kimi K2.7).
   * When provided, the probe emits `thinking: { type, budget_tokens }` so the
   * upstream accepts the request without burning real completion tokens.
   */
  thinking?: { type: 'enabled'; budget_tokens: number };
}

/**
 * Probe an Anthropic-compatible endpoint with a minimal `/v1/messages` request.
 *
 * Sends `max_tokens: 1` so the upstream never produces real completion output.
 * Auth headers are sent as both `x-api-key` and `Authorization: Bearer` so the
 * probe works against Anthropic-native proxies as well as OpenAI-style gateways
 * fronting Anthropic-compatible schemas.
 *
 * @throws {Error} when the credentials are rejected, the upstream returns a
 *   non-2xx response, or the request times out / fails at the network layer.
 */
export async function probeAnthropicCompatCredentials(
  options: AnthropicCompatProbeOptions
): Promise<void> {
  const {
    baseUrl,
    apiKey,
    model,
    providerName,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    thinking,
  } = options;

  const url = `${normalizeBaseUrlForProbe(baseUrl)}/v1/messages`;

  const payload: Record<string, unknown> = {
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: '.' }],
  };
  if (thinking) {
    payload.thinking = thinking;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`${providerName} probe timed out after ${timeoutMs}ms`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${providerName} probe failed: ${detail}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`${providerName} API key rejected (HTTP ${response.status})`);
  }
  // 404 / 400 etc. can indicate the key is valid but the request shape is off
  // (e.g. wrong model ID). Treat 4xx other than auth as a probe configuration
  // error so we don't false-positive healthy, but still surface the upstream's
  // verdict. 5xx means the upstream itself is unhealthy.
  if (!response.ok) {
    throw new Error(`${providerName} probe failed (HTTP ${response.status})`);
  }
}
