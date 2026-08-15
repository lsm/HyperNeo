/**
 * Legacy-hook coverage — the completeness check for the hooks-v2 cutover.
 *
 * A workflow that still carries the legacy `hooks` array may only run on the
 * v2 engine (or drop its legacy column) when EVERY legacy hook id has an
 * enabled v2 binding. "Any nonempty hook_bindings" is NOT conversion: a
 * partially migrated workflow would run only the new bindings and silently
 * skip the remaining legacy gates — and migration 197 would then drop the
 * legacy definitions permanently. Engine-free (shared by task-agent-manager,
 * the workflow manager, and migration 197).
 */
import type { HookBinding } from '@hyperneo/shared';

/** Parse the distinct GATE ids out of a legacy `hooks` JSON array. The
 * legacy instance `id` is NOT generally the v2 hook id: the built-in Coding
 * template stored `id: 'code-pr-ready'` with `validator.id: 'pr_ready'`,
 * and its v2 replacement binding uses `hookId: 'pr_ready'`. Coverage keys
 * on the VALIDATOR id (the gate identity the v2 binding must recreate),
 * falling back to the instance id for legacy script hooks whose instance
 * id WAS the gate identity. Returns empty for absent/non-array/shapeless
 * values. */
export function legacyHookIds(legacyHooks: unknown): string[] {
  if (!Array.isArray(legacyHooks)) return [];
  const ids = new Set<string>();
  for (const entry of legacyHooks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const validator = record.validator;
    const validatorId =
      typeof validator === 'string'
        ? validator
        : validator && typeof validator === 'object' && !Array.isArray(validator)
          ? (validator as Record<string, unknown>).id
          : undefined;
    const id =
      typeof validatorId === 'string' && validatorId.trim().length > 0 ? validatorId : record.id;
    if (typeof id === 'string' && id.trim().length > 0) ids.add(id);
  }
  return [...ids];
}

export interface LegacyHookCoverage {
  /** True when the workflow has no legacy hooks, or every legacy hook id is
   * covered by an enabled v2 binding. */
  complete: boolean;
  /** Legacy hook ids with no enabled v2 binding (empty when complete). */
  missing: string[];
}

/** Whether the given enabled v2 bindings cover every legacy hook id. */
export function legacyHookCoverage(
  legacyHooks: unknown,
  bindings: HookBinding[] | undefined
): LegacyHookCoverage {
  const ids = legacyHookIds(legacyHooks);
  if (ids.length === 0) return { complete: true, missing: [] };
  const bound = new Set((bindings ?? []).filter((b) => b.enabled !== false).map((b) => b.hookId));
  const missing = ids.filter((id) => !bound.has(id));
  return { complete: missing.length === 0, missing };
}
