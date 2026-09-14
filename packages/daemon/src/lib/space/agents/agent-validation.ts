import { KNOWN_TOOLS, isKnownToolEntry, modelPoolEntryKey } from '@hyperneo/shared';
import {
  getAvailableModels,
  getModelsCache,
  getModelInfoUnfiltered,
  isValidModel,
} from '../../model-service.ts';
import { getProviderRegistry } from '../../providers/registry.js';
import { isValidThinkingLevel } from './agent-field-validation.ts';

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
  const trimmedProvider = provider?.trim() || undefined;
  if (trimmedProvider) {
    const registered = getProviderRegistry().get(trimmedProvider);
    if (registered && !registered.ownsModel(model)) {
      return `Unrecognized model "${model}" for provider "${trimmedProvider}"`;
    }
  }

  const available = getAvailableModels('global');
  if (available.length === 0 && !getModelsCache().has('global')) return null;

  if (trimmedProvider) {
    const valid = await isValidModel(model, 'global', trimmedProvider);
    return valid ? null : `Unrecognized model "${model}" for provider "${trimmedProvider}"`;
  }

  const info = await getModelInfoUnfiltered(model, 'global');
  return info ? null : `Unrecognized model: "${model}"`;
}

export async function validateAgentModelPool(
  pool: {
    model: string;
    provider?: string | null;
    maxConcurrent: number;
    weight: number;
    thinkingLevel?: string | null;
  }[]
): Promise<string | null> {
  const seen = new Set<string>();
  for (const entry of pool) {
    if (!entry.model) return 'Model pool entries must specify a model';
    const entryKey = modelPoolEntryKey({
      model: entry.model,
      provider: entry.provider ?? undefined,
    });
    if (seen.has(entryKey)) {
      return (
        `Model pool contains duplicate entries for "${entry.model}"` +
        (entry.provider ? ` on provider "${entry.provider}"` : '')
      );
    }
    seen.add(entryKey);
    if (!Number.isInteger(entry.maxConcurrent) || entry.maxConcurrent < 1) {
      return `Model pool entry for "${entry.model}" must have an integer maxConcurrent >= 1`;
    }
    if (!Number.isFinite(entry.weight) || entry.weight < 0) {
      return `Model pool entry for "${entry.model}" must have weight >= 0`;
    }
    if (
      entry.thinkingLevel !== undefined &&
      entry.thinkingLevel !== null &&
      !isValidThinkingLevel(entry.thinkingLevel)
    ) {
      return `Model pool entry for "${entry.model}" has an invalid thinkingLevel: ${String(entry.thinkingLevel)}`;
    }
    const modelError = await validateAgentModel(entry.model, entry.provider ?? null);
    if (modelError) return modelError;
  }
  if (!pool.some((entry) => entry.weight > 0)) {
    return 'Model pool must have at least one entry with weight > 0';
  }
  return null;
}
