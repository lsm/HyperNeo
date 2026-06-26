/**
 * Worker tool policy helpers.
 *
 * SpaceAgent.tools is a visible tool profile, not an exhaustive Claude Code SDK
 * built-in allowlist. Worker sessions should inherit SDK defaults and MCP tools,
 * then explicitly deny only tools whose absence is a behavioral restriction.
 */

const WORKER_MUTATION_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
const WORKER_SHELL_EQUIVALENT_TOOLS = ['Bash', 'REPL', 'Workflow'] as const;
/**
 * Built-ins that are not Bash-equivalent but still execute commands, mutate
 * runtime state, or spawn processes. Denied for no-shell worker profiles so a
 * read-only reviewer cannot bypass the Bash deny via Monitor/Cron/Trigger.
 */
const WORKER_EXECUTABLE_AUXILIARY_TOOLS = [
  'Monitor',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
  'PushNotification',
  'Artifact',
  'Projects',
  'TaskCreate',
  'TaskUpdate',
  'TodoWrite',
  'Agent',
  'EnterPlanMode',
  'ExitPlanMode',
] as const;

/**
 * Built-in preset agent names whose runtime contract is read-only-mutation
 * regardless of what the persisted `tools` row says. Used to migrate upgraded
 * Spaces: a Reviewer row seeded before this PR may not deny the mutation
 * tools, but the contract forbids file mutation + state-mutation, so the
 * runtime enforces the deny list for preset Reviewers even when the stored
 * profile has not been synced yet.
 *
 * Note: shell-equivalent tools (Bash/REPL/Workflow) are intentionally NOT
 * denied for Reviewer. The Reviewer needs read-only shell (`gh pr diff`,
 * `git log`, `gh pr checks`) to gather evidence. Destructive commands are
 * blocked by `REVIEWER_NO_MUTATION_GUARD` at the workflow level.
 */
export const READ_ONLY_PRESET_TEMPLATE_NAMES = new Set(['Reviewer']);

/**
 * Built-in preset agent names whose runtime contract is full-coding
 * (read + write + shell). Used to migrate upgraded Spaces: rows seeded before
 * MultiEdit was added to the profile omit it, so without this override the
 * permissive policy would silently deny MultiEdit for those Coder/General/
 * Planner/Research presets until an operator runs syncFromTemplate. When the
 * templateName is in this set, MultiEdit is treated as included in the profile
 * even when the stale stored row omits it.
 */
export const FULL_CODING_PRESET_TEMPLATE_NAMES = new Set([
  'Coder',
  'General',
  'Planner',
  'Research',
  'Coordinator',
]);

/**
 * Tools that the current full-coding preset templates always include, even
 * when a stale persisted row (seeded before the tool was added) omits them.
 * Used to backfill the profile so the permissive policy does not treat the
 * omission as an intentional restriction.
 */
const FULL_CODING_PRESET_BACKFILL_TOOLS = ['MultiEdit'] as const;

/**
 * Built-in preset agent names whose runtime contract is restricted-aux even
 * when the persisted profile keeps Bash for validation. QA keeps Bash so it
 * can run tests, but the visible profile omits Projects / TaskCreate /
 * TaskUpdate / TodoWrite / Agent / Artifact / worktree / scheduler mutators,
 * and the runtime should deny those omissions rather than letting the SDK
 * inherit them via FULL_BUILTIN_TOOL_LIST expansion. Without this override
 * a prompt-injected QA agent could mutate project state or spawn teammates
 * via tools the profile never granted.
 */
export const RESTRICTED_AUX_PRESET_TEMPLATE_NAMES = new Set(['QA']);

/**
 * Convert a visible tool profile into explicit worker denies.
 *
 * No profile means permissive default: leave SDK built-ins and MCP tools inherited.
 * A profile that omits non-restricted tools must not deny them, so new SDK tools
 * and scheduler/skill tools remain available unless explicitly guarded elsewhere.
 *
 * `REPL` and `Workflow` are denied with `Bash` for no-shell profiles. Existing
 * full worker profiles may predate those SDK built-ins, so their omission alone
 * must not make coding agents less permissive when `Bash` remains available.
 * Executable auxiliary tools (Monitor/Cron/Trigger/worktree/PushNotification)
 * are likewise denied for no-shell profiles so a read-only reviewer cannot
 * bypass the Bash deny via those entry points.
 *
 * `options.templateName` — when the agent is a built-in preset whose contract
 * is read-only-mutation (currently 'Reviewer'), the mutation + aux deny list
 * is forced even if the persisted `tools` row still contains the mutation
 * tools. Shell-equivalent tools are NOT denied; destructive commands are
 * blocked by REVIEWER_NO_MUTATION_GUARD at the workflow level. This migrates
 * upgraded Spaces without waiting for an explicit syncFromTemplate RPC.
 */
export function deriveWorkerDisallowedTools(
  toolProfile?: readonly string[] | null,
  options?: { templateName?: string | null }
): string[] {
  // Force the read-only-mutation contract for built-in Reviewer presets
  // regardless of the stored profile so pre-migration rows cannot keep
  // Write/Edit/MultiEdit/aux-mutators. Shell-equivalent tools (Bash/REPL/
  // Workflow) are intentionally NOT denied — Reviewer needs read shell.
  // Destructive commands are blocked by REVIEWER_NO_MUTATION_GUARD.
  if (options?.templateName && READ_ONLY_PRESET_TEMPLATE_NAMES.has(options.templateName)) {
    return [...WORKER_EXECUTABLE_AUXILIARY_TOOLS, ...WORKER_MUTATION_TOOLS];
  }

  if (!toolProfile || toolProfile.length === 0) return [];

  // Backfill the profile for stale full-coding preset rows so tools the
  // current preset includes (notably MultiEdit) are not treated as
  // intentionally restricted just because the persisted row predates them.
  let effectiveProfile = toolProfile;
  if (
    options?.templateName &&
    FULL_CODING_PRESET_TEMPLATE_NAMES.has(options.templateName) &&
    !toolProfile.includes('MultiEdit')
  ) {
    effectiveProfile = [...toolProfile, ...FULL_CODING_PRESET_BACKFILL_TOOLS];
  }

  const allowedProfileTools = new Set(effectiveProfile);
  const disallowed: string[] = [];

  const bashPresent = allowedProfileTools.has('Bash');
  // Restricted-aux presets (currently QA) keep Bash for validation but must
  // still deny the auxiliary mutators AND the shell-equivalent tools they
  // omit (REPL/Workflow). Without this, FULL_BUILTIN_TOOL_LIST expansion on
  // non-native providers would surface those tools to a prompt-injected QA
  // agent.
  const isRestrictedAuxPreset =
    options?.templateName !== undefined &&
    options.templateName !== null &&
    RESTRICTED_AUX_PRESET_TEMPLATE_NAMES.has(options.templateName);
  const denyAuxRegardlessOfBash = !bashPresent || isRestrictedAuxPreset;
  const denyShellEquivRegardlessOfBash = !bashPresent || isRestrictedAuxPreset;

  if (denyShellEquivRegardlessOfBash) {
    disallowed.push(
      ...WORKER_SHELL_EQUIVALENT_TOOLS.filter((tool) => !allowedProfileTools.has(tool))
    );
  }
  if (denyAuxRegardlessOfBash) {
    disallowed.push(
      ...WORKER_EXECUTABLE_AUXILIARY_TOOLS.filter((tool) => !allowedProfileTools.has(tool))
    );
  }

  disallowed.push(...WORKER_MUTATION_TOOLS.filter((tool) => !allowedProfileTools.has(tool)));

  return disallowed;
}
