const CANONICAL_SDK_IDS = new Set(['default', 'sonnet', 'opus', 'haiku', 'fable', 'sonnet[1m]']);

export function isAnthropicSdkModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (CANONICAL_SDK_IDS.has(lower)) return true;
  return lower.startsWith('claude-');
}

export function canonicalAnthropicSdkAlias(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  return CANONICAL_SDK_IDS.has(lower) ? lower : undefined;
}
