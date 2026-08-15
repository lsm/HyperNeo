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
  const placements = legacyPlacements(legacyHooks);
  if (placements.length === 0) return { complete: true, missing: [] };
  // Coverage matches each legacy PLACEMENT'S ROUTE, not just the id count:
  // a `pr_ready` binding on a different target or method satisfies an
  // id-only count while the legacy gate's actual route stays ungated (and
  // the manager/migration can then delete the original definition). Each
  // placement consumes ONE enabled binding with the SAME id, method, and
  // target; a binding covers at most one placement (v2 forbids one id on
  // multiple routes anyway).
  const enabled = (bindings ?? []).filter((b) => b.enabled !== false);
  const used = new Set<number>();
  const missing: string[] = [];
  for (const p of placements) {
    // A placement that NAMES a target requires the binding's target to match;
    // a legacy record with no routing field constrains only id + method (it
    // did not record which route it gated, so any route counts as covering).
    const match = enabled.findIndex(
      (b, i) =>
        !used.has(i) &&
        b.hookId === p.id &&
        b.method === p.method &&
        (p.target === undefined || b.targetNode === p.target)
    );
    if (match === -1) {
      missing.push(p.id);
    } else {
      used.add(match);
    }
  }
  return { complete: missing.length === 0, missing };
}

/** One legacy gate placement: the validator identity plus its ROUTE. */
export interface LegacyHookPlacement {
  id: string;
  method: string;
  sourceNode?: string;
  target?: string;
}

/** Parse per-placement legacy gate descriptors (id + route). The method
 * defaults to send_message (the legacy-gated MCP action); the target comes
 * from the legacy hook's routing fields when present. */
export function legacyPlacements(legacyHooks: unknown): LegacyHookPlacement[] {
  if (!Array.isArray(legacyHooks)) return [];
  const out: LegacyHookPlacement[] = [];
  for (const entry of legacyHooks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const validator = record.validator;
    const validatorRec =
      validator && typeof validator === 'object' && !Array.isArray(validator)
        ? (validator as Record<string, unknown>)
        : undefined;
    const validatorId = typeof validator === 'string' ? validator : validatorRec?.id;
    const id =
      typeof validatorId === 'string' && validatorId.trim().length > 0 ? validatorId : record.id;
    if (typeof id !== 'string' || id.trim().length === 0) continue;
    const method =
      typeof record.method === 'string'
        ? record.method
        : typeof validatorRec?.method === 'string'
          ? (validatorRec.method as string)
          : 'send_message';
    const sourceNode = typeof record.sourceNode === 'string' ? record.sourceNode : undefined;
    const target = typeof record.targetNode === 'string' ? record.targetNode : undefined;
    out.push({ id, method, sourceNode, target });
  }
  return out;
}
