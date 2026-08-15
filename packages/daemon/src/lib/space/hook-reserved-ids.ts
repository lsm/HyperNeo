/**
 * Engine-free reserved hook identifiers.
 *
 * `LEGACY_GUARD_HOOK_ID` is needed by BOTH the runtime engine and the
 * validators/export-format (which must stay engine-free). Defining it here
 * breaks the transitive dependency (export-format -> workflow-hook-validation
 * -> workflow-hook-engine) that a local literal only papered over.
 */

/** Synthetic hook id reserved by the legacy-cutover fail-closed guard. */
export const LEGACY_GUARD_HOOK_ID = '__legacy_hooks__';

/**
 * Synthetic hook id for the corrupt-hook-column fail-closed marker emitted
 * by SpaceWorkflowRepository when hook_bindings/custom_hooks cannot be
 * decoded. Never registered — the engine's "hook not registered" path blocks
 * every matched action with this id.
 */
export const CORRUPT_HOOK_BINDINGS_HOOK_ID = '__corrupt_hook_bindings__';

/**
 * Synthetic hook id for TRANSIENT routing-store failures (the execution
 * repository unreadable during binding resolution). Distinct from the
 * PERMANENT legacy guard so the web banner does not conflate a recoverable
 * outage with the un-migratable cutover state — and cleared automatically
 * once routing evaluation succeeds again.
 */
export const ROUTING_UNAVAILABLE_HOOK_ID = '__routing_unavailable__';

/** All reserved `__`-prefixed synthetic hook ids a custom hook must not use. */
export const RESERVED_HOOK_IDS = [
  LEGACY_GUARD_HOOK_ID,
  CORRUPT_HOOK_BINDINGS_HOOK_ID,
  ROUTING_UNAVAILABLE_HOOK_ID,
] as const;
