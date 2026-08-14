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
