import type { ModelInfo } from '@hyperneo/shared';

export function usableModels(models: readonly ModelInfo[], provider?: string): ModelInfo[] {
  return models.filter(
    (entry) => entry.available !== false && (!provider || entry.provider === provider)
  );
}

export function matchModelIdOrName(models: readonly ModelInfo[], requested: string): ModelInfo[] {
  const exact = models.find((entry) => entry.id === requested);
  if (exact) return [exact];
  const name = requested.toLowerCase();
  return models.filter((entry) => entry.name?.toLowerCase() === name);
}
