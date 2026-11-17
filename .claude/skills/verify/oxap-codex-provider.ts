const PROBE = 'https://api.openai.com/v1/responses';

export const OXAP_CODEX_MODEL = 'codex-6-luna';

export const oxapCodexProvider = {
  params: {
    providerId: 'anthropic-codex',
    displayName: 'Synthetic OXAP Codex',
    kind: 'built_in',
    authType: 'api_key',
    isEnabled: true,
    isDefault: false,
    sortOrder: 1,
    configJson: JSON.stringify({ harness: 'oxap-codex' }),
  },
  credentials: { apiKey: 'sk-synthetic-oxap-codex' },
};

export function answerCodexProbeLocally(): string[] {
  const probes: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === PROBE) {
        probes.push(url);
        return new Response('{}', { status: 200 });
      }
      if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return real(input, init);
      throw new Error(`Synthetic OXAP proof refused a network request to ${url}`);
    },
    { preconnect: real.preconnect }
  ) as typeof fetch;
  return probes;
}
