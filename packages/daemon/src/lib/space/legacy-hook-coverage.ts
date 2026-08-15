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

/** Parse the distinct hook ids out of a legacy `hooks` JSON array. Returns
 * empty when the value is absent/empty/not an array of objects with ids. */
export function legacyHookIds(legacyHooks: unknown): string[] {
  if (!Array.isArray(legacyHooks)) return [];
  const ids = new Set<string>();
  for (const entry of legacyHooks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = (entry as Record<string, unknown>).id;
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
