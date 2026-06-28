/**
 * Worker tool policy helpers.
 *
 * SpaceWorkerAgent.tools is a visible profile, not an exhaustive SDK allowlist.
 * Worker sessions inherit SDK defaults and MCP tools; this helper only denies
 * behaviorally restricted mutators that are absent from a configured profile.
 */

const MUTATION_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

export interface WorkerToolPolicyOptions {
  /** Additional mutating tools to deny when omitted from a configured profile. */
  auxMutators?: readonly string[];
}

/**
 * Derive the built-in tools a worker should not have from its visible profile.
 *
 * No profile means permissive defaults: inherit SDK built-ins and MCP tools.
 * When a profile is present, only mutating built-ins are denied if omitted.
 * Shell-equivalent tools such as Bash are intentionally not denied here; read-only
 * Bash restrictions are deferred to behavioral guards/follow-up work.
 */
export function deriveWorkerDisallowedTools(
  toolProfile: readonly string[] | null | undefined,
  options: WorkerToolPolicyOptions = {}
): string[] {
  if (!toolProfile || toolProfile.length === 0) return [];

  const allowed = new Set(toolProfile);
  const restricted = [...MUTATION_TOOLS, ...(options.auxMutators ?? [])];
  return restricted.filter((tool) => !allowed.has(tool));
}
