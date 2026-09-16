import { DENIABLE_TOOLS, isScopedBashToolEntry } from '@hyperneo/shared';

export interface WorkerToolPolicyOptions {
  auxMutators?: readonly string[];
}

export function deriveWorkerDisallowedTools(
  toolProfile: readonly string[] | null | undefined,
  options: WorkerToolPolicyOptions = {}
): string[] {
  if (!toolProfile || toolProfile.length === 0) return [];

  const allowed = new Set(toolProfile);
  const hasScopedBash = toolProfile.some((tool) => isScopedBashToolEntry(tool));
  const restricted = [...DENIABLE_TOOLS, ...(options.auxMutators ?? [])];
  return restricted.filter((tool) => {
    if (allowed.has(tool)) return false;
    if (tool === 'Bash' && hasScopedBash) return false;
    return true;
  });
}
