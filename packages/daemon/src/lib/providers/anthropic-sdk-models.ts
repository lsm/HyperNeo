const CANONICAL_SDK_IDS = new Set(['default', 'sonnet', 'opus', 'haiku', 'fable']);

export function isAnthropicSdkModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase().replace(/\[1m\]$/, '');
  return CANONICAL_SDK_IDS.has(lower) || lower.startsWith('claude-');
}

const ONE_M_CONTEXT_MODELS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
]);

export function anthropicContextWindow(modelId: string): number {
  return /\[1m\]$/i.test(modelId) || ONE_M_CONTEXT_MODELS.has(modelId.toLowerCase())
    ? 1_000_000
    : 200000;
}
