import { KNOWN_TOOLS, isKnownToolEntry } from '@hyperneo/shared';
import {
  getAvailableModels,
  getModelsCache,
  getModelInfoUnfiltered,
  isValidModel,
} from '../../model-service.ts';

export type SpaceAgentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; details?: string[] };

export function validateSpaceAgentTools(tools: string[]): string | null {
  const invalid = tools.filter((t) => !isKnownToolEntry(t));
  if (invalid.length === 0) return null;
  return `Unknown tool${invalid.length > 1 ? 's' : ''}: ${invalid.map((t) => `"${t}"`).join(', ')}. Valid tools: ${KNOWN_TOOLS.join(', ')} or scoped Bash entries like 'Bash(gh pr view:*)'`;
}

export async function validateAgentModel(
  model: string,
  provider?: string | null
): Promise<string | null> {
  const available = getAvailableModels('global');
  if (available.length === 0 && !getModelsCache().has('global')) return null;

  if (provider) {
    const valid = await isValidModel(model, 'global', provider);
    return valid ? null : `Unrecognized model "${model}" for provider "${provider}"`;
  }

  const info = await getModelInfoUnfiltered(model, 'global');
  return info ? null : `Unrecognized model: "${model}"`;
}

export async function validateAgentModelPool(
  pool: { model: string; maxConcurrent: number; weight: number }[]
): Promise<string | null> {
  const seen = new Set<string>();
  for (const entry of pool) {
    if (!entry.model) return 'Model pool entries must specify a model';
    if (seen.has(entry.model)) {
      return `Model pool contains duplicate entries for "${entry.model}"`;
    }
    seen.add(entry.model);
    if (!Number.isInteger(entry.maxConcurrent) || entry.maxConcurrent < 1) {
      return `Model pool entry for "${entry.model}" must have an integer maxConcurrent >= 1`;
    }
    if (!Number.isFinite(entry.weight) || entry.weight < 0) {
      return `Model pool entry for "${entry.model}" must have weight >= 0`;
    }
    const modelError = await validateAgentModel(entry.model);
    if (modelError) return modelError;
  }
  if (!pool.some((entry) => entry.weight > 0)) {
    return 'Model pool must have at least one entry with weight > 0';
  }
  return null;
}
