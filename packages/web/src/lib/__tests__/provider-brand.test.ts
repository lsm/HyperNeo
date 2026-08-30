import { describe, it, expect, afterEach } from 'vitest';
import {
  PROVIDER_BRAND_COLORS,
  getProviderBrandColor,
  providerPillStyle,
  providerLogoColor,
  providerHeaderStyle,
  shortenModelName,
} from '../provider-brand';
import { resolvedTheme } from '../theme';

describe('provider-brand', () => {
  describe('getProviderBrandColor', () => {
    it('returns the brand color for every known provider', () => {
      expect(getProviderBrandColor('anthropic')).toBe('#D97757');
      expect(getProviderBrandColor('anthropic-copilot')).toBe('#8957E5');
      expect(getProviderBrandColor('anthropic-codex')).toBe('#FFFFFF');
      expect(getProviderBrandColor('openrouter')).toBe('#007CF0');
      expect(getProviderBrandColor('glm')).toBe('#7DD3FC');
      expect(getProviderBrandColor('kimi')).toBe('#B197FC');
      expect(getProviderBrandColor('minimax')).toBe('#FCA5A5');
      expect(getProviderBrandColor('ollama')).toBe('#CBD5E1');
      expect(getProviderBrandColor('gemini')).toBe('#4285F4');
    });

    it('falls back to neutral gray for unknown providers', () => {
      expect(getProviderBrandColor('some-unknown-provider')).toBe('#9CA3AF');
    });

    it('falls back to neutral gray for undefined/null provider', () => {
      expect(getProviderBrandColor(undefined)).toBe('#9CA3AF');
      expect(getProviderBrandColor(null)).toBe('#9CA3AF');
    });

    it('keeps every known provider off the fallback gray', () => {
      for (const provider of Object.keys(PROVIDER_BRAND_COLORS)) {
        expect(
          getProviderBrandColor(provider),
          `${provider} should have an explicit brand color`
        ).not.toBe('#9CA3AF');
      }
    });
  });

  describe('providerPillStyle', () => {
    afterEach(() => {
      resolvedTheme.value = 'dark';
    });

    it('mixes the brand color into a translucent background + border', () => {
      resolvedTheme.value = 'dark';
      const style = providerPillStyle('anthropic');
      expect(style.backgroundColor).toContain('#D97757');
      expect(style.backgroundColor).toContain('color-mix');
      expect(style.borderColor).toContain('#D97757');
    });

    it('uses a darker tint in light mode for pale brands', () => {
      resolvedTheme.value = 'light';
      expect(providerPillStyle('anthropic-codex').borderColor).toContain('#3f3f46');
    });

    it('uses the fallback gray for unknown providers', () => {
      resolvedTheme.value = 'dark';
      expect(providerPillStyle('nope').backgroundColor).toContain('#9CA3AF');
    });
  });

  describe('providerLogoColor', () => {
    afterEach(() => {
      resolvedTheme.value = 'dark';
    });

    it('lifts the brand hue toward white in dark mode', () => {
      resolvedTheme.value = 'dark';
      expect(providerLogoColor('glm')).toContain('#7DD3FC');
      expect(providerLogoColor('glm')).toContain('#ffffff');
    });

    it('uses the darker Light-mode variant directly', () => {
      resolvedTheme.value = 'light';
      expect(providerLogoColor('glm')).toBe('#0369a1');
      expect(providerLogoColor('anthropic-codex')).toBe('#3f3f46');
    });
  });

  describe('providerHeaderStyle', () => {
    afterEach(() => {
      resolvedTheme.value = 'dark';
    });

    it('returns a brand-tinted band + brand-hued text color in dark mode', () => {
      resolvedTheme.value = 'dark';
      const style = providerHeaderStyle('anthropic');
      expect(style.backgroundColor).toContain('#D97757');
      expect(style.color).toContain('#D97757');
    });

    it('uses darker foreground variants in light mode for pale brands', () => {
      resolvedTheme.value = 'light';
      expect(providerHeaderStyle('anthropic-codex').color).toBe('#3f3f46');
      expect(providerHeaderStyle('glm').color).toBe('#0369a1');
      expect(providerHeaderStyle('kimi').color).toBe('#7c3aed');
    });

    it('falls back to gray for unknown providers', () => {
      resolvedTheme.value = 'dark';
      expect(providerHeaderStyle('nope').backgroundColor).toContain('#9CA3AF');
    });
  });

  describe('shortenModelName', () => {
    it('strips aggregator vendor prefixes for known aggregator providers', () => {
      expect(shortenModelName('OpenAI: GPT-5', 'openrouter')).toBe('GPT-5');
    });

    it('preserves colon prefixes for custom or unknown providers', () => {
      expect(shortenModelName('Prod: Llama 3.1', 'custom:my-model')).toBe('Prod: Llama 3.1');
      expect(shortenModelName('Staging: Llama 3.1', 'unknown-provider')).toBe('Staging: Llama 3.1');
      expect(shortenModelName('Prod: Llama 3.1', 'anthropic')).toBe('Prod: Llama 3.1');
    });

    it('strips the Kimi brand prefix only for the dedicated Kimi provider', () => {
      expect(shortenModelName('Kimi K2.7', 'kimi')).toBe('K2.7');
      expect(shortenModelName('Kimi K2 Thinking', 'kimi')).toBe('K2 Thinking');
      expect(shortenModelName('MoonshotAI: Kimi K2.6', 'openrouter')).toBe('Kimi K2.6');
    });

    it('preserves Kimi marketing names without a version code', () => {
      expect(shortenModelName('Kimi For Coding', 'kimi')).toBe('Kimi For Coding');
    });

    it('strips trailing provider tags in parens', () => {
      expect(shortenModelName('Haiku 4.5 (Copilot)', 'anthropic-copilot')).toBe('Haiku 4.5');
      expect(shortenModelName('GPT-5 Mini (Copilot)', 'anthropic-copilot')).toBe('GPT-5 Mini');
      expect(shortenModelName('Auto (Copilot)', 'anthropic-copilot')).toBe('Auto');
    });

    it('strips the redundant brand prefix the logo conveys', () => {
      expect(shortenModelName('Claude Opus 4.8', 'anthropic')).toBe('Opus 4.8');
      expect(shortenModelName('MiniMax M2', 'minimax')).toBe('M2');
      expect(shortenModelName('Copilot gpt-5', 'anthropic-copilot')).toBe('gpt-5');
    });

    it('preserves a brand name riding inside another provider group', () => {
      expect(shortenModelName('Claude Haiku 4.5', 'anthropic-copilot')).toBe('Claude Haiku 4.5');
    });

    it('strips vendor prefix + known provider tag together', () => {
      expect(shortenModelName('MoonshotAI: Kimi K2.6 (Copilot)', 'openrouter')).toBe('Kimi K2.6');
    });

    it('preserves non-provider qualifiers like (free) and (preview)', () => {
      expect(shortenModelName('Qwen3.6 (free)', 'openrouter')).toBe('Qwen3.6 (free)');
      expect(shortenModelName('DeepSeek V4 (preview)', 'openrouter')).toBe('DeepSeek V4 (preview)');
    });

    it('leaves short / family-named models intact', () => {
      expect(shortenModelName('GLM-5', 'glm')).toBe('GLM-5');
      expect(shortenModelName('gpt-5.5', 'anthropic-codex')).toBe('gpt-5.5');
      expect(shortenModelName('Sonnet 4.5', 'anthropic')).toBe('Sonnet 4.5');
      expect(shortenModelName('GPT-5.3 Codex', 'anthropic-codex')).toBe('GPT-5.3 Codex');
    });

    it('returns empty string for empty input', () => {
      expect(shortenModelName('', 'anthropic')).toBe('');
      expect(shortenModelName('   ', 'anthropic')).toBe('');
    });

    it('leaves unknown providers unstripped (beyond vendor/tag removal)', () => {
      expect(shortenModelName('Some Model X', 'unknown-provider')).toBe('Some Model X');
    });
  });
});
