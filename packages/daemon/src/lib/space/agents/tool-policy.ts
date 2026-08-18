import { DENIABLE_TOOLS } from '@hyperneo/shared';

export interface WorkerToolPolicyOptions {
  auxMutators?: readonly string[];
}

export function deriveWorkerDisallowedTools(
  toolProfile: readonly string[] | null | undefined,
  options: WorkerToolPolicyOptions = {}
): string[] {
  if (!toolProfile || toolProfile.length === 0) return [];

  const allowed = new Set(toolProfile);
  const restricted = [...DENIABLE_TOOLS, ...(options.auxMutators ?? [])];
  return restricted.filter((tool) => !allowed.has(tool));
}
