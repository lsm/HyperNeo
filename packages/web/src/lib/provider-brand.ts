/**
 * Provider brand identity — brand colors + display helpers shared by
 * model-selection surfaces (composer pill, model picker, settings).
 *
 * Brand colors mirror the per-provider dot colors historically rendered inline
 * in SessionStatusBar; centralized here so the composer pill, picker header,
 * and identity affordances never drift apart. Keep in sync with
 * PROVIDER_LABELS in packages/web/src/hooks/useModelSwitcher.ts.
 */

/** Brand-accurate provider colors (hex values outside Tailwind's palette). */
export const PROVIDER_BRAND_COLORS: Record<string, string> = {
  anthropic: '#D97757',
  'anthropic-copilot': '#8957E5',
  'anthropic-codex': '#FFFFFF', // OpenAI — white; the pill renders a glassy white tint
  openrouter: '#007CF0',
  glm: '#7DD3FC',
  kimi: '#B197FC',
  minimax: '#FCA5A5',
  ollama: '#CBD5E1',
  gemini: '#4285F4',
};

const DEFAULT_BRAND_COLOR = '#9CA3AF';

/** Resolve the brand color for a provider, falling back to neutral gray. */
export function getProviderBrandColor(provider: string | undefined | null): string {
  if (!provider) return DEFAULT_BRAND_COLOR;
  return PROVIDER_BRAND_COLORS[provider] ?? DEFAULT_BRAND_COLOR;
}

/** Inline style for a brand-tinted pill background + border. */
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

/** `currentColor` for a provider logo on a tinted pill — brand hue lifted toward white. */
export function providerLogoColor(provider: string | undefined | null): string {
  const brand = getProviderBrandColor(provider);
  return `color-mix(in srgb, ${brand} 80%, #ffffff 20%)`;
}

/** Inline style for a provider section header: subtle brand-tinted band + brand-hued text. */
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

/**
 * Brand-family prefixes the group's logo already conveys. Keyed by provider so
 * a brand name riding inside ANOTHER provider's group is preserved:
 *   - "Claude Haiku 4.5" under Copilot keeps "Claude" (Copilot is multi-vendor)
 *   - "Kimi K2.7" under OpenRouter keeps "Kimi"  (OpenRouter is multi-vendor)
 *   - "Kimi K2.7" under the dedicated Kimi group  -> "K2.7"
 * The Kimi rule is version-anchored so non-code names like "Kimi For Coding"
 * stay intact.
 */
const REDUNDANT_BRAND_PREFIXES: Record<string, RegExp> = {
  anthropic: /^Claude\s+/i,
  kimi: /^Kimi\s+(?=K\d)/i,
  minimax: /^MiniMax\s+/i,
  'anthropic-copilot': /^Copilot\s+/i,
};

// Aggregator vendor prefix, e.g. "MoonshotAI: Kimi K2.7" (OpenRouter style).
// Only stripped for providers known to use aggregator naming, so custom or
// user-configured deployments like "Prod: Llama 3.1" keep their prefix.
const VENDOR_PREFIX = /^[A-Za-z][A-Za-z0-9_.-]*:\s+/;
const AGGREGATOR_PROVIDERS = new Set(['openrouter']);
// Trailing provider tag, e.g. "Haiku 4.5 (Copilot)". Only strips tags whose
// content is a known provider label, preserving capability qualifiers like
// "(free)", "(preview)", or "(1M context)" that disambiguate models.
const KNOWN_PROVIDER_LABELS = [
  'Anthropic',
  'GLM',
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

/**
 * Shorten a model display name for compact surfaces (composer pill, picker
 * rows). Strips, in order:
 *   - aggregator vendor prefixes      ("MoonshotAI: Kimi K2.7" -> "Kimi K2.7")
 *   - trailing provider tag in parens ("Haiku 4.5 (Copilot)" -> "Haiku 4.5")
 *   - the provider's OWN brand prefix ("Claude Opus 4.8" -> "Opus 4.8",
 *     "Kimi K2.7" -> "K2.7" under the Kimi group)
 * A brand word is only dropped for the provider that owns it, so aggregators
 * (OpenRouter, Copilot) keep the vendor name that disambiguates models.
 */
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
