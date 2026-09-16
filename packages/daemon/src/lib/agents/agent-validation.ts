import { isKnownToolEntry, KNOWN_TOOLS } from '@hyperneo/shared';
import {
  getAvailableModels,
  getModelInfoUnfiltered,
  getModelsCache,
  isValidModel,
} from '../model-service.ts';

export function validateAgentTools(tools: string[]): string | null {
  const invalid = tools.filter((toolName) => !isKnownToolEntry(toolName));
  if (invalid.length === 0) return null;
  return `Unknown tool${invalid.length > 1 ? 's' : ''}: ${invalid
    .map((toolName) => `"${toolName}"`)
    .join(
      ', '
    )}. Valid tools: ${KNOWN_TOOLS.join(', ')} or scoped Bash entries like 'Bash(gh pr view:*)'`;
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
