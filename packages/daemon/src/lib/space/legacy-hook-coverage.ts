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
/** Parse the PER-PLACEMENT gate ids out of a legacy `hooks` JSON array. The
 * legacy instance `id` is NOT generally the v2 hook id: the built-in Coding
 * template stored `id: 'code-pr-ready'` with `validator.id: 'pr_ready'`,
 * and its v2 replacement binding uses `hookId: 'pr_ready'`. Coverage keys
 * on the VALIDATOR id (the gate identity the v2 binding must recreate),
 * falling back to the instance id for legacy script hooks whose instance
 * id WAS the gate identity. Entries are deliberately NOT deduped: two hook
 * instances sharing a validator id are two placements that each need a v2
 * binding. Returns empty for absent/non-array/shapeless values. */
export function legacyHookIds(legacyHooks: unknown): string[] {
  if (!Array.isArray(legacyHooks)) return [];
  const list: string[] = [];
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
    if (typeof id === 'string' && id.trim().length > 0) list.push(id);
  }
  return list;
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
  // Count PER PLACEMENT, not per distinct id: a legacy workflow may place
  // the same validator id on two routes, and v2 currently FORBIDS placing
  // one hook id on multiple bindings — a set-based check would let a single
  // binding satisfy both placements while the second route's gate is
  // silently dropped. Every placement needs a distinct enabled binding;
  // since v2 cannot place one id twice, an under-covered workflow stays
  // fail-closed until multi-placement is supported or the routes are
  // re-authored with distinct hooks.
  const enabled = (bindings ?? []).filter((b) => b.enabled !== false);
  const missing: string[] = [];
  const placementCounts = new Map<string, number>();
  for (const id of ids) placementCounts.set(id, (placementCounts.get(id) ?? 0) + 1);
  for (const [id, placements] of placementCounts) {
    const boundCount = enabled.filter((b) => b.hookId === id).length;
    if (boundCount < placements) missing.push(id);
  }
  return { complete: missing.length === 0, missing };
}
