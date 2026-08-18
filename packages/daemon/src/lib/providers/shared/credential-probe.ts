export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

export function normalizeBaseUrlForProbe(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export interface AnthropicCompatProbeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  thinking?: { type: 'enabled'; budget_tokens: number };
}

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
    max_tokens: thinking ? thinking.budget_tokens + 1 : 1,
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
  if (!response.ok) {
    throw new Error(`${providerName} probe failed (HTTP ${response.status})`);
  }
}
