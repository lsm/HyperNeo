import type { AgentModelPoolEntry, ThinkingLevel } from '@hyperneo/shared';

export const DEFAULT_POOL_MAX_CONCURRENT = 1;
export const DEFAULT_POOL_WEIGHT = 100;

export interface ModelConfigSource {
  model?: string | null;
  provider?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  modelPool?: AgentModelPoolEntry[] | null;
}

export interface ResolvedModelConfig {
  model: string | null;
  provider: string | null;
  thinkingLevel: ThinkingLevel | null;
  modelPool: AgentModelPoolEntry[] | null;
}

export function newPoolEntry(): AgentModelPoolEntry {
  return { model: '', maxConcurrent: DEFAULT_POOL_MAX_CONCURRENT, weight: DEFAULT_POOL_WEIGHT };
}

export function poolFromModelConfig(
  source: ModelConfigSource | null | undefined
): AgentModelPoolEntry[] {
  if (!source) return [];
  const inherited = source.thinkingLevel ?? null;
  if (source.model) {
    return [
      {
        model: source.model,
        ...(source.provider ? { provider: source.provider } : {}),
        maxConcurrent: DEFAULT_POOL_MAX_CONCURRENT,
        weight: DEFAULT_POOL_WEIGHT,
        ...(inherited ? { thinkingLevel: inherited } : {}),
      },
    ];
  }
  const stored = source.modelPool ?? [];
  if (stored.length === 0) return [];
  if (!inherited) return stored;
  return stored.map((entry) =>
    entry.thinkingLevel ? entry : { ...entry, thinkingLevel: inherited }
  );
}

function isScalarEquivalent(pool: AgentModelPoolEntry[]): boolean {
  if (pool.length !== 1) return false;
  const [only] = pool;
  return only.maxConcurrent === DEFAULT_POOL_MAX_CONCURRENT && only.weight === DEFAULT_POOL_WEIGHT;
}

export function isStoredAsPool(source: ModelConfigSource | null | undefined): boolean {
  if (!source || source.model) return false;
  return (source.modelPool?.length ?? 0) > 0;
}

export function withoutInheritedThinkingLevel(
  source: ModelConfigSource | null | undefined
): ModelConfigSource | null {
  if (!source) return null;
  return { model: source.model, provider: source.provider, modelPool: source.modelPool };
}

export function modelConfigFromPool(
  pool: AgentModelPoolEntry[],
  keepAsPool = false
): ResolvedModelConfig {
  const cleaned = pool
    .map((entry) => ({ ...entry, model: entry.model.trim() }))
    .filter((entry) => entry.model.length > 0);
  if (cleaned.length === 0) {
    return { model: null, provider: null, thinkingLevel: null, modelPool: null };
  }
  if (!keepAsPool && isScalarEquivalent(cleaned)) {
    const [only] = cleaned;
    return {
      model: only.model,
      provider: only.provider?.trim() || null,
      thinkingLevel: only.thinkingLevel ?? null,
      modelPool: null,
    };
  }
  return { model: null, provider: null, thinkingLevel: null, modelPool: cleaned };
}

export function storedModelConfig(
  source: ModelConfigSource | null | undefined
): ResolvedModelConfig {
  return modelConfigFromPool(poolFromModelConfig(source), isStoredAsPool(source));
}

export function thinkingLevelForSave(
  config: ResolvedModelConfig,
  source: ModelConfigSource | null | undefined
): ThinkingLevel | null {
  if (config.model) return config.thinkingLevel;
  return source?.thinkingLevel ?? null;
}

export function sameModelConfig(a: ResolvedModelConfig, b: ResolvedModelConfig): boolean {
  return (
    a.model === b.model &&
    a.provider === b.provider &&
    a.thinkingLevel === b.thinkingLevel &&
    JSON.stringify(a.modelPool) === JSON.stringify(b.modelPool)
  );
}
