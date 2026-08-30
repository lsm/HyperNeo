import { resolvedTheme } from './theme';

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
  acp: '#F97316',
};

const PROVIDER_BRAND_COLORS_LIGHT: Record<string, string> = {
  anthropic: '#9a3412',
  'anthropic-copilot': '#6d28d9',
  'anthropic-codex': '#3f3f46',
  openrouter: '#0369a1',
  glm: '#0369a1',
  kimi: '#7c3aed',
  minimax: '#dc2626',
  deepseek: '#3730a3',
  ollama: '#475569',
  gemini: '#1d4ed8',
  acp: '#c2410c',
};

const DEFAULT_BRAND_COLOR = '#9CA3AF';
const DEFAULT_BRAND_COLOR_LIGHT = '#52525b';

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
  const light = resolvedTheme.value === 'light';
  const brand = light ? getProviderBrandColorLight(provider) : getProviderBrandColor(provider);
  return {
    backgroundColor: `color-mix(in srgb, ${brand} 10%, transparent)`,
    color: light ? brand : providerLogoColor(provider),
  };
}

function getProviderBrandColorLight(provider: string | undefined | null): string {
  if (!provider) return DEFAULT_BRAND_COLOR_LIGHT;
  return PROVIDER_BRAND_COLORS_LIGHT[provider] ?? DEFAULT_BRAND_COLOR_LIGHT;
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
