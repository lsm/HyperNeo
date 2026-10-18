const CANONICAL_SDK_IDS = new Set(['default', 'sonnet', 'opus', 'haiku', 'fable']);

export function isAnthropicSdkModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase().replace(/\[1m\]$/, '');
  return CANONICAL_SDK_IDS.has(lower) || lower.startsWith('claude-');
}
