/**
 * Hook registry — resolves a {@link HookBinding.hookId} to its Layer-1
 * definition.
 *
 * Built-in hooks live in `@hyperneo/extensions-hooks` (business logic the daemon
 * must not own) and are loaded by id. Custom (script) hooks are authored
 * per-workflow in `SpaceWorkflow.customHooks` and referenced the same way. The
 * engine uses this to find a hook's `run`; prompt generation uses it to find a
 * hook's `requiredData`.
 *
 * See `docs/features/workflow-hooks-v2.md`.
 */

import { BUILT_IN_HOOKS } from '@hyperneo/extensions-hooks';
import type { CustomHook, Hook } from '@hyperneo/shared';

const BUILT_IN_HOOK_BY_ID: ReadonlyMap<string, Hook> = new Map(
  BUILT_IN_HOOKS.map((hook) => [hook.id, hook])
);

/** A resolved hook is either a built-in (TS `run`) or a custom (script) hook. */
export type ResolvedHook = Hook | CustomHook;

/** True for a built-in hook (TS `run` function) vs a custom script hook. */
export function isBuiltInHook(hook: ResolvedHook): hook is Hook {
  return typeof (hook as Hook).run === 'function';
}

/**
 * Resolve the hook a binding references: a built-in from the registry, else a
 * custom hook authored on the workflow. Returns undefined for a dangling id
 * (misconfiguration the engine logs and skips).
 */
export function resolveHook(
  hookId: string,
  customHooks: CustomHook[] | undefined
): ResolvedHook | undefined {
  const builtIn = BUILT_IN_HOOK_BY_ID.get(hookId);
  if (builtIn) return builtIn;
  // Defensive against malformed entries (e.g. a null element) reaching here
  // despite validation — skip non-records instead of throwing.
  return customHooks?.find((hook) => !!hook && typeof hook === 'object' && hook.id === hookId) as
    | ResolvedHook
    | undefined;
}
