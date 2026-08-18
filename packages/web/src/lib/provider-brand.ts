export const PROVIDER_BRAND_COLORS: Record<string, string> = {
  anthropic: '#D97757',
  'anthropic-copilot': '#8957E5',
  'anthropic-codex': '#FFFFFF',
  openrouter: '#007CF0',
  glm: '#7DD3FC',
  kimi: '#B197FC',
  minimax: '#FCA5A5',
  deepseek: '#4D6BFE',
  ollama: '#CBD5E1',
  gemini: '#4285F4',
};

const DEFAULT_BRAND_COLOR = '#9CA3AF';

export function getProviderBrandColor(provider: string | undefined | null): string {
  if (!provider) return DEFAULT_BRAND_COLOR;
  return PROVIDER_BRAND_COLORS[provider] ?? DEFAULT_BRAND_COLOR;
}

export function providerPillStyle(provider: string | undefined | null): {
  backgroundColor: string;
  borderColor: string;
} {
  const brand = getProviderBrandColor(provider);
  return {
    backgroundColor: `color-mix(in srgb, ${brand} 14%, transparent)`,
    borderColor: `color-mix(in srgb, ${brand} 42%, transparent)`,
  };
}

export function providerLogoColor(provider: string | undefined | null): string {
  const brand = getProviderBrandColor(provider);
  return `color-mix(in srgb, ${brand} 80%, #ffffff 20%)`;
}

export function providerHeaderStyle(provider: string | undefined | null): {
  backgroundColor: string;
  color: string;
} {
  const brand = getProviderBrandColor(provider);
  return {
    backgroundColor: `color-mix(in srgb, ${brand} 10%, transparent)`,
    color: providerLogoColor(provider),
  };
}

const REDUNDANT_BRAND_PREFIXES: Record<string, RegExp> = {
  anthropic: /^Claude\s+/i,
  kimi: /^Kimi\s+(?=K\d)/i,
  minimax: /^MiniMax\s+/i,
  'anthropic-copilot': /^Copilot\s+/i,
};

const VENDOR_PREFIX = /^[A-Za-z][A-Za-z0-9_.-]*:\s+/;
const AGGREGATOR_PROVIDERS = new Set(['openrouter']);
const KNOWN_PROVIDER_LABELS = [
  'Anthropic',
  'Z.ai',
  'Kimi',
  'MiniMax',
  'OpenRouter',
  'Copilot',
  'Codex',
];
const TRAILING_PROVIDER_TAG = new RegExp(
  `\\s*\\((?:${KNOWN_PROVIDER_LABELS.join('|')})\\)\\s*$`,
  'i'
);

export function shortenModelName(name: string, provider?: string): string {
  let s = (name || '').trim();
  if (!s) return '';
  if (provider && AGGREGATOR_PROVIDERS.has(provider)) {
    s = s.replace(VENDOR_PREFIX, '').trim();
  }
  s = s.replace(TRAILING_PROVIDER_TAG, '').trim();
  const re = provider ? REDUNDANT_BRAND_PREFIXES[provider] : undefined;
  if (re) s = s.replace(re, '').trim();
  return s;
}
