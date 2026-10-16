import type { AnthropicRequest } from '../provider-anthropic-compat/translator.js';

export function extractSystemText(system: AnthropicRequest['system'] | undefined): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((block) => block.text).join('\n');
}
