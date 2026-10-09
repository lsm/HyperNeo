import type { ModelInfo } from '@hyperneo/shared';

export function usableModels(models: readonly ModelInfo[], provider?: string): ModelInfo[] {
  return models.filter(
    (entry) => entry.available !== false && (!provider || entry.provider === provider)
  );
}
