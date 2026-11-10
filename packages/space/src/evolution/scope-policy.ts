import type { EvolutionPolicy } from '@hyperneo/shared';

export function mergeEvolutionPolicy(
  policy: EvolutionPolicy,
  patch: EvolutionPolicy
): EvolutionPolicy {
  const merged: EvolutionPolicy = { ...policy, ...patch };
  for (const key of Object.keys(patch)) {
    if (
      patch[key as keyof EvolutionPolicy] === undefined ||
      patch[key as keyof EvolutionPolicy] === null
    ) {
      delete (merged as Record<string, unknown>)[key];
    }
  }
  const patchAutomation = patch.automation;
  const isValidObject =
    patchAutomation !== undefined &&
    typeof patchAutomation === 'object' &&
    !Array.isArray(patchAutomation) &&
    patchAutomation !== null;
  if (isValidObject) {
    const automation = { ...policy.automation, ...patchAutomation };
    for (const key of Object.keys(patchAutomation)) {
      const value = (patchAutomation as Record<string, unknown>)[key];
      if (value === undefined || value === null) {
        delete (automation as Record<string, unknown>)[key];
      }
    }
    merged.automation = automation;
  }
  return merged;
}
