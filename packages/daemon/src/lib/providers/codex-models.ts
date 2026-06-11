import type { ModelInfo } from '@neokai/shared';

export const MODEL_CONTEXT_WINDOWS = {
  'gpt-5.3-codex': 272000,
  'gpt-5.4': 272000,
  'gpt-5.5': 272000,
  'gpt-5.4-mini': 128000,
  'gpt-5.1-codex-mini': 128000,
} as const;

export type CodexBridgeModelId = keyof typeof MODEL_CONTEXT_WINDOWS;

const CODEX_MODEL_ALIASES = {
  codex: 'gpt-5.3-codex',
  'codex-5.4': 'gpt-5.4',
  'codex-latest': 'gpt-5.5',
  'codex-mini': 'gpt-5.4-mini',
  'gpt-5.1-mini': 'gpt-5.1-codex-mini',
  'codex-5.1-mini': 'gpt-5.1-codex-mini',
} as const satisfies Record<string, CodexBridgeModelId>;

const CODEX_MODEL_DETAILS = {
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
  'gpt-5.5': {
    name: 'GPT-5.5',
    alias: 'codex-latest',
    description: 'GPT-5.5 · Latest frontier agentic coding model',
    releaseDate: '2026-04-01',
  },
  'gpt-5.4-mini': {
    name: 'GPT-5.4 Mini',
    alias: 'codex-mini',
    description: 'GPT-5.4 Mini · Fast and efficient for simpler tasks',
    releaseDate: '2026-01-01',
  },
  'gpt-5.1-codex-mini': {
    name: 'GPT-5.1 Codex Mini',
    alias: 'codex-5.1-mini',
    description: 'GPT-5.1 Codex Mini · Fast and efficient for simpler tasks',
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

/**
 * Anthropic model IDs to present to the Claude Agent SDK so it uses a large
 * context window instead of falling back to ~200 k for unknown Codex IDs.
 *
 * The SDK has a hard-coded model database and also preflights context using
 * provider `/v1/models` responses. When it sees a Codex ID or a 200 k Sonnet
 * alias, it can reject requests before NeoKai's own compaction threshold.
 *
 * We route Codex primary models through `claude-opus-4-1-20250805` because it
 * is the latest Opus ID the current SDK (0.2.141) recognises as large-context.
 * Newer IDs such as `claude-opus-4-20250918` are not in the SDK's hard-coded
 * database and would trigger the same fallback.
 *
 * These overrides are used for:
 *   - `translateModelIdForSdk()` (so the SDK sends the Anthropic ID in the
 *     request body to the bridge)
 *   - `ANTHROPIC_DEFAULT_*_MODEL` env vars (so SDK sub-agents use the same
 *     large-context IDs)
 *
 * The bridge then maps the Anthropic ID back to the real Codex model ID via
 * `modelAliases` (plus per-session overrides) before forwarding to OpenAI.
 *
 * Architectural limitation: multiple Codex models share the same SDK alias
 * (e.g. gpt-5.5, gpt-5.3-codex, gpt-5.4 all map to claude-opus-4-1-20250805).
 * The bridge cannot distinguish between different logical uses of the same
 * alias (primary vs fallback vs sub-agent tier). Per-session overrides use
 * last-wins semantics so model switching works correctly. Known trade-offs:
 *   - Opus sub-agents use the user's selected model instead of gpt-5.5
 *   - Same-tier fallback registration overwrites the primary model override
 * Both are acceptable: sub-agent tier routing is approximate, and same-tier
 * fallback is rare (models are similar within a tier).
 */
export const CODEX_TO_SDK_ANTHROPIC_MODEL: Record<CodexBridgeModelId, string> = {
  'gpt-5.5': 'claude-opus-4-1-20250805',
  'gpt-5.3-codex': 'claude-opus-4-1-20250805',
  'gpt-5.4': 'claude-opus-4-1-20250805',
  'gpt-5.4-mini': 'claude-sonnet-4-20250514',
  'gpt-5.1-codex-mini': 'claude-sonnet-4-20250514',
};

/**
 * Reverse mapping: Anthropic SDK model ID → default Codex model ID.
 * Used by the bridge's `modelAliases` so incoming requests are resolved to
 * a canonical OpenAI model before being sent upstream.
 *
 * Note: multiple Codex models map to the same Anthropic ID (we only have one
 * 1 M Anthropic model ID). The bridge resolves to the canonical model for that
 * tier — `gpt-5.5` for the 1 M tier and `gpt-5.4-mini` for the 200 k tier.
 *
 * Per-session overrides (via `setSessionModelConfig`) take precedence over
 * this default mapping so the originally-selected Codex model is preserved.
 */
export const SDK_ANTHROPIC_TO_CODEX_MODEL: Record<string, CodexBridgeModelId> = {
  'claude-opus-4-1-20250805': 'gpt-5.5',
  'claude-sonnet-4-20250514': 'gpt-5.4-mini',
};

export function getCodexBridgeModelInfos(): ModelInfo[] {
  return (Object.keys(MODEL_CONTEXT_WINDOWS) as CodexBridgeModelId[]).map((id) => {
    const details = CODEX_MODEL_DETAILS[id];
    return {
      id,
      name: details.name,
      alias: details.alias,
      sdkModelIds: [CODEX_TO_SDK_ANTHROPIC_MODEL[id]].filter(Boolean),
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
