/**
 * Reviewer contract migration override.
 *
 * Preset Reviewer rows seeded before the no-shell migration still carry the
 * old shell-based review procedure in their persisted customPrompt. The
 * runtime enforces the Bash deny list for those rows via
 * `READ_ONLY_PRESET_TEMPLATE_NAMES`, but without an explicit prompt override
 * the model is instructed to call `gh pr review` / `gh pr diff` while Bash
 * is blocked, which breaks review turns.
 *
 * `applyReviewerContractMigrationOverride` appends the current
 * `REVIEWER_SYSTEM_CONTRACT` under a precedence-explicit header so the model
 * sees the no-shell instructions regardless of what the stale stored prompt
 * says. Shared across the createCustomAgentInit and long-term-agent refresh
 * paths so both surfaces stay in sync.
 *
 * Gating: the override is only appended when the stored prompt looks stale —
 * i.e. it lacks the current no-shell contract marker AND it contains one of
 * the retired shell-based procedure markers. This prevents duplicating the
 * contract for Reviewer rows that are already current, and avoids appending
 * stock instructions under a "supersedes conflicts" header to user-customised
 * Reviewer prompts that happen to retain the templateName.
 */

import { REVIEWER_SYSTEM_CONTRACT } from './system-contracts';
import { READ_ONLY_PRESET_TEMPLATE_NAMES } from './tool-policy';

const MIGRATION_OVERRIDE_HEADER =
  '## Updated Reviewer Contract (migration override; supersedes any conflicting shell-based review procedure above)';

/**
 * Markers that indicate the persisted prompt predates the no-shell contract.
 * Any one of these in the stored customPrompt means the row is stale and the
 * migration override should apply.
 */
const RETIRED_SHELL_PROCEDURE_MARKERS = [
  'gh pr review',
  'gh pr diff',
  'gh pr view',
  'gh api graphql',
  'gh api repos/{owner}/{repo}/issues',
  'gh api repos/{owner}/{repo}/pulls/{n}/reviews',
  '/pulls/{n}/comments',
  'run tests if uncertain',
];

/**
 * Marker present in the current no-shell contract. Used to detect that the
 * stored prompt is already current so the override can be skipped.
 */
const CURRENT_CONTRACT_MARKER = 'Read-only rule:';

/**
 * Decide whether the persisted Reviewer prompt is stale (predates the
 * no-shell contract) and therefore needs the migration override.
 *
 * Returns true when the prompt lacks the current contract marker AND contains
 * at least one retired shell-based procedure marker. Fresh seeds (whose
 * customPrompt equals the current contract) and user-customised Reviewer rows
 * that happen to omit the shell markers both return false.
 */
export function reviewerPromptNeedsMigrationOverride(prompt: string): boolean {
  if (prompt.includes(CURRENT_CONTRACT_MARKER)) return false;
  return RETIRED_SHELL_PROCEDURE_MARKERS.some((marker) => prompt.includes(marker));
}

/**
 * Append the current Reviewer contract as a migration override when the agent
 * is a preset read-only template (currently Reviewer) AND the stored prompt
 * looks stale (see reviewerPromptNeedsMigrationOverride). Otherwise return
 * the resolved prompt unchanged.
 */
export function applyReviewerContractMigrationOverride(
  resolvedPrompt: string,
  templateName?: string | null
): string {
  if (!templateName || !READ_ONLY_PRESET_TEMPLATE_NAMES.has(templateName)) {
    return resolvedPrompt;
  }
  if (!reviewerPromptNeedsMigrationOverride(resolvedPrompt)) {
    return resolvedPrompt;
  }
  const migrationOverride = `\n\n${MIGRATION_OVERRIDE_HEADER}\n\n${REVIEWER_SYSTEM_CONTRACT}`;
  return resolvedPrompt ? `${resolvedPrompt}${migrationOverride}` : REVIEWER_SYSTEM_CONTRACT;
}
