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
}

export const AUTO_COMPACT_PERCENT_DEFAULT = 90;
export const AUTO_COMPACT_PERCENT_MIN = 10;
export const AUTO_COMPACT_PERCENT_MAX = 100;

export function resolveAutoCompactPercent(raw?: number | null): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return AUTO_COMPACT_PERCENT_DEFAULT;
  return Math.min(AUTO_COMPACT_PERCENT_MAX, Math.max(AUTO_COMPACT_PERCENT_MIN, Math.floor(raw)));
}

export interface CurrentModelInfo {
  id: string;
  info: ModelInfo | null;
}
