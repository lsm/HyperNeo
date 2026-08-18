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
  description: string;
  releaseDate: string;
  available: boolean;
  thinkingModes?: 'off' | 'on' | 'granular';
}

export interface CurrentModelInfo {
  id: string;
  info: ModelInfo | null;
}
