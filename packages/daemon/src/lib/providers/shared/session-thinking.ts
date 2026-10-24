import { normalizeThinkingLevel, THINKING_LEVEL_TOKENS } from '@hyperneo/shared';
import type { AnthropicRequest } from '../provider-anthropic-compat/translator.js';

export function sessionThinkingForLevel(level: string | undefined): AnthropicRequest['thinking'] {
  if (level === undefined) return undefined;
  const tokens = THINKING_LEVEL_TOKENS[normalizeThinkingLevel(level)];
  return tokens === undefined ? { type: 'disabled' } : { type: 'enabled', budget_tokens: tokens };
}
