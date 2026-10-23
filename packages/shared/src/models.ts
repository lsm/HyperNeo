export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'glm' | string;

export interface ModelInfo {
  id: string;
  name: string;
  alias: string;
  sdkModelIds?: string[];
  providerAliases?: string[];
  providerAliasPrefixes?: string[];
  family: ModelFamily;
  provider: string;
  contextWindow: number;
  preferContextWindowMetadata?: boolean;
  autoCompactPercent?: number;
  description: string;
  releaseDate: string;
  available: boolean;
  thinkingModes?: 'off' | 'on' | 'granular';
  effortLevels?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
}

export const AUTO_COMPACT_PERCENT_DEFAULT = 90;
export const AUTO_COMPACT_PERCENT_MIN = 10;
export const AUTO_COMPACT_PERCENT_MAX = 100;

export function resolveAutoCompactPercent(raw?: number | null): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return AUTO_COMPACT_PERCENT_DEFAULT;
  return Math.min(AUTO_COMPACT_PERCENT_MAX, Math.max(AUTO_COMPACT_PERCENT_MIN, Math.floor(raw)));
}

function baseModelId(id: string): string {
  return id.replace(/(\[1m\])+$/i, '');
}

export function findSameModel<T extends Pick<ModelInfo, 'id' | 'alias' | 'provider'>>(
  models: readonly T[],
  entry: { model: string; provider: string }
): T | undefined {
  const candidates = models.filter((model) => model.provider === entry.provider);
  const wanted = baseModelId(entry.model);
  return (
    candidates.find((model) => model.id === entry.model) ??
    candidates.find((model) =>
      [model.id, model.alias].some((name) => name && baseModelId(name) === wanted)
    )
  );
}

export interface CurrentModelInfo {
  id: string;
  info: ModelInfo | null;
}
