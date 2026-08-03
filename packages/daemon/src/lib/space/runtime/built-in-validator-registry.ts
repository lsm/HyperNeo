/**
 * Built-in validator registry — epic #2299 (P2 #2302).
 *
 * The single source of truth for which built-in validator ids are IMPLEMENTED.
 * Both layers consult it so the engine special-cases no id:
 *   - `workflow-hook-validation.ts` admits a `built_in` id iff it is registered
 *     here (replaces the old hardcoded `VALID_BUILT_IN_VALIDATORS = new
 *     Set(['pr_ready'])` literal — the engine no longer enumerates ids).
 *   - `hook-executor.ts` dispatches a `built_in` id by looking up its function
 *     here (replaces the local `BUILT_IN_VALIDATORS` Map).
 *
 * A registered id is a "named preset" (ADR #2 of the epic): `pr_ready` /
 * `pr_merged` compile to external-state checks over a connector + predicate
 * (see `connectors/presets.ts`). The registry holds the compiled validator
 * function; the connector + predicate live in the preset, not the engine.
 *
 * This is a LEAF module: it owns only the Map + accessors (mirrors the L2
 * connector registry in `connectors/connector.ts`). It type-imports
 * `BuiltInValidatorFn` from `hook-executor.ts`; concrete validators are wired
 * in `built-in-validators/index.ts`, imported for its side effect by
 * `workflow-hook-validation.ts` so the registry is populated before any
 * validation runs. Keyed by `string` (like the connector registry) — the
 * `WorkflowHookValidatorId` union is a nominal cue, not the authority.
 */

import type { BuiltInValidatorFn } from './hook-executor';

const builtInValidators = new Map<string, BuiltInValidatorFn>();

/** Register a built-in validator by id. Overwrites an existing entry. */
export function registerBuiltInValidator(id: string, fn: BuiltInValidatorFn): void {
  builtInValidators.set(id, fn);
}

/** Look up a built-in validator by id. Undefined when unregistered. */
export function getBuiltInValidator(id: string): BuiltInValidatorFn | undefined {
  return builtInValidators.get(id);
}

/** Whether a built-in validator id is registered (i.e. implemented). Used by
 *  workflow validation to admit `built_in` ids generically. */
export function isRegisteredBuiltInValidator(id: string): boolean {
  return builtInValidators.has(id);
}

/** All registered (implemented) built-in validator ids. */
export function getRegisteredBuiltInValidatorIds(): string[] {
  return [...builtInValidators.keys()];
}

/** Clear the registry (test helper). */
export function clearBuiltInValidatorRegistry(): void {
  builtInValidators.clear();
}
