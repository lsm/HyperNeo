/**
 * Worker tool policy helpers.
 *
 * SpaceWorkerAgent.tools is a visible profile, not an exhaustive SDK allowlist.
 * Worker sessions inherit SDK defaults and MCP tools; this helper only denies
 * mutating built-ins that are absent from a configured profile.
 */

import { DENIABLE_TOOLS } from '@hyperneo/shared';

export interface WorkerToolPolicyOptions {
  /** Additional tools to deny when omitted from a configured profile. */
  auxMutators?: readonly string[];
}

/**
 * Derive the built-in tools a worker should not have from its visible profile.
 *
 * No profile means permissive defaults: inherit SDK built-ins and MCP tools.
 * When a profile is present, mutating built-ins are denied if omitted.
 */
export function deriveWorkerDisallowedTools(
  toolProfile: readonly string[] | null | undefined,
  options: WorkerToolPolicyOptions = {}
): string[] {
  if (!toolProfile || toolProfile.length === 0) return [];

  const allowed = new Set(toolProfile);
  const restricted = [...DENIABLE_TOOLS, ...(options.auxMutators ?? [])];
  return restricted.filter((tool) => !allowed.has(tool));
}
