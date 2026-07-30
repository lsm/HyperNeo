import type { ModelInfo } from '@hyperneo/shared';

export const MODEL_CONTEXT_WINDOWS = {
  'gpt-5.6-sol': 372000,
  'gpt-5.6-terra': 372000,
  'gpt-5.6-luna': 372000,
  'gpt-5.5': 272000,
  'gpt-5.3-codex': 272000,
  'gpt-5.4': 272000,
  'gpt-5.4-mini': 128000,
} as const;

export type CodexBridgeModelId = keyof typeof MODEL_CONTEXT_WINDOWS;

const CODEX_MODEL_ALIASES = {
  codex: 'gpt-5.3-codex',
  'codex-5.4': 'gpt-5.4',
  'codex-5.5': 'gpt-5.5',
  'codex-latest': 'gpt-5.6-sol',
  'codex-5.6': 'gpt-5.6-sol',
  'codex-5.6-sol': 'gpt-5.6-sol',
  'codex-5.6-terra': 'gpt-5.6-terra',
  'codex-5.6-luna': 'gpt-5.6-luna',
  'codex-mini': 'gpt-5.6-luna',
  'codex-5.4-mini': 'gpt-5.4-mini',
} as const satisfies Record<string, CodexBridgeModelId>;

const CODEX_MODEL_DETAILS = {
  'gpt-5.6-sol': {
    name: 'GPT-5.6 Sol',
    alias: 'codex-latest',
    description: 'GPT-5.6 Sol · Flagship reasoning/coding model with Ultra mode',
    releaseDate: '2026-07-09',
  },
  'gpt-5.6-terra': {
    name: 'GPT-5.6 Terra',
    alias: 'codex-5.6-terra',
    description: 'GPT-5.6 Terra · Balanced GPT-5.5-level coding model',
    releaseDate: '2026-07-09',
  },
  'gpt-5.6-luna': {
    name: 'GPT-5.6 Luna',
    alias: 'codex-mini',
    description: 'GPT-5.6 Luna · Fast and efficient for high-volume workloads',
    releaseDate: '2026-07-09',
  },
  'gpt-5.5': {
    name: 'GPT-5.5',
    alias: 'codex-5.5',
    description: 'GPT-5.5 · Frontier agentic coding model',
    releaseDate: '2026-04-01',
  },
  'gpt-5.3-codex': {
    name: 'GPT-5.3 Codex',
    alias: 'codex',
    description: 'GPT-5.3 Codex · Best for coding and complex reasoning',
    releaseDate: '2025-12-01',
  },
  'gpt-5.4': {
    name: 'GPT-5.4',
    alias: 'codex-5.4',
    description: 'GPT-5.4 · Frontier agentic coding model',
    releaseDate: '2026-01-01',
  },
  'gpt-5.4-mini': {
    name: 'GPT-5.4 Mini',
    alias: 'codex-5.4-mini',
    description: 'GPT-5.4 Mini · Fast and efficient for simpler tasks',
    releaseDate: '2026-01-01',
  },
} as const satisfies Record<
  CodexBridgeModelId,
  { name: string; alias: string; description: string; releaseDate: string }
>;

export function resolveCodexBridgeModelId(modelId: string): CodexBridgeModelId | undefined {
  const aliased = CODEX_MODEL_ALIASES[modelId as keyof typeof CODEX_MODEL_ALIASES];
  const resolved = aliased ?? modelId;
  if (resolved in MODEL_CONTEXT_WINDOWS) {
    return resolved as CodexBridgeModelId;
  }
  return undefined;
}

export function getModelContextWindow(modelId: string): number | undefined {
  const resolved = resolveCodexBridgeModelId(modelId);
  return resolved ? MODEL_CONTEXT_WINDOWS[resolved] : undefined;
}

function getProviderAliases(id: CodexBridgeModelId, primaryAlias: string): string[] {
  return Object.entries(CODEX_MODEL_ALIASES)
    .filter(([, target]) => target === id)
    .map(([alias]) => alias)
    .filter((alias) => alias !== primaryAlias);
}

/**
 * Codex model IDs for SDK routing.
 *
 * Following the GLM/Kimi pattern, we use real Codex model IDs directly instead
 * of aliasing to Anthropic model IDs. The SDK reads context window from
 * `/v1/models` metadata (via preferContextWindowMetadata: true) instead of its
 * hardcoded database, avoiding token counting mismatch.
 *
 * This identity mapping is used for:
 *   - `ANTHROPIC_DEFAULT_*_MODEL` env vars (so SDK sub-agents use real Codex IDs)
 *   - `buildSdkConfig()` resolution
 *
 * The bridge's per-session model overrides ensure the originally-selected Codex
 * model ID is preserved when the SDK sends requests.
 */
export const CODEX_TO_SDK_MODEL: Record<CodexBridgeModelId, string> = {
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.3-codex': 'gpt-5.3-codex',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.4-mini': 'gpt-5.4-mini',
};

export function getCodexBridgeModelInfos(): ModelInfo[] {
  return (Object.keys(MODEL_CONTEXT_WINDOWS) as CodexBridgeModelId[]).map((id) => {
    const details = CODEX_MODEL_DETAILS[id];
    const providerAliases = getProviderAliases(id, details.alias);
    return {
      id,
      name: details.name,
      alias: details.alias,
      sdkModelIds: [CODEX_TO_SDK_MODEL[id]].filter(Boolean),
      ...(providerAliases.length > 0 ? { providerAliases } : {}),
      family: 'gpt',
      provider: 'anthropic-codex',
      contextWindow: MODEL_CONTEXT_WINDOWS[id],
      preferContextWindowMetadata: true,
      description: details.description,
      releaseDate: details.releaseDate,
      available: true,
    };
  });
}
