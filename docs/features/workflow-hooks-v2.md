# Workflow Hooks v2

Status: design spec. Drives the `feat/workflow-hooks-v2` PR series.

## Principle

Hook bodies are **business logic** ("a PR must be mergeable", "a review must be
posted"). Business logic does not live in the daemon. The daemon keeps only
infrastructure: the chain engine, routing, persistence, sandboxing, and the
capability context it injects into each hook. The rules move to a dedicated
package.

## 1. Two layers

A hook and its placement in a workflow are separate things.

**Layer 1 — the hook (definition, reusable):**

```ts
interface Hook {
  id: string;                                       // e.g. 'pr_ready'
  requiredData: DataField[];                        // the input contract (data)
  run: (action: HookAction, ctx: HookContext) => Promise<HookReturn>;
}

interface DataField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'link';
  required: boolean;
  description?: string;
}
```

A hook knows nothing about nodes or methods. The function knows what data it
needs, so `requiredData` lives here.

**Layer 2 — the binding (how a workflow uses a hook):**

```ts
interface HookBinding {
  hookId: string;                                   // references a Layer-1 hook, or a local custom hook id
  sourceNode: string;
  targetNode: string;
  method: HookMethod;                               // send_message | submit_for_approval | mark_complete | ...
  order: number;
  enabled: boolean;
  authorizedCallers?: AuthorizedCaller[];
}
```

A workflow is nodes + channels + `hookBindings[]`. Built-in hooks are referenced
by `hookId`; custom hooks are defined inline (§3) and referenced the same way.

## 2. Package layout

Built-in hooks live in **`packages/extensions/hooks`**
(`@hyperneo/extensions-hooks`), depending only on `@hyperneo/shared`. It exports
the built-in `Hook` definitions. `run` receives a `HookContext` (defined in
shared, implemented by the daemon) for every capability — the package never
imports daemon internals. `packages/extensions/` is the home for hook extensions
and any future extension kinds.

## 3. Custom / script hooks

User-authored hooks cannot be TypeScript (it is not safe to run arbitrary TS),
so they are bash scripts defined per-workflow in a local `hooks[]`:

```ts
interface CustomHook {
  id: string;
  requiredData: DataField[];
  run: { kind: 'script'; interpreter: 'bash'; source: string; timeoutMs?: number };
}
```

The daemon executor branches on the hook kind: a built-in → call the registry's
TS function; a custom → spawn the sandboxed bash. `requiredData` is authored
alongside either.

**Trust boundary.** Custom scripts run as the daemon's own OS user. The
restricted environment, isolated `HOME`, process-group reaping, and bounded
buffers are hygiene — NOT an OS sandbox: a script can resolve the account's
real home via the passwd database and read daemon-owned files. Only run
custom hooks from workflows you author; importing a bundle imports its
scripts with the daemon's filesystem privileges. An OS-level sandbox for
imported scripts is a tracked follow-up.

**Custom script hooks are restricted to stateless flow decisions.** The
script's only bridge to the run is a read-only snapshot environment
(`HYPERNEO_PARAMS_JSON`, `HYPERNEO_CURRENT_ARTIFACTS_JSON`, run/node/task
identity — see `buildScriptEnv`), and its stdout is consumed as flow metadata
only (`flow` / `reason` / `payload` / `retryAfterMs`); every other field,
including `result`, is logged and ignored. There is deliberately **no script
bridge to the `HookContext` side-effecting methods** (`readState`,
`recordState`, `queueFollowUp`, `writeArtifact`) — bash cannot call the
injected JS functions, and snapshots of mutable state would invite
lost-update bugs. A hook that needs state, follow-ups, or artifacts must be a
built-in (or a new built-in added to `@hyperneo/extensions-hooks`). A bounded
file/stdout protocol for script side effects is a tracked follow-up; until it
lands, the custom-hook contract is exactly "decide the flow".

## 4. Return contract — hooks own their side effects

```ts
type Flow = 'continue' | 'stop' | 'retry';

interface HookReturn {
  flow: Flow;
  reason?: string;                                  // shown to the agent on stop / retry
  payload?: Record<string, unknown>;                // optional rewrite of the action params before delivery
  retryAfterMs?: number;
  result?: unknown;                                 // optional: record of what the hook did (audit/log/UI)
}
```

There is **no `effects` field** and **no `validator` / `side_effect`
classification**. The hook performs its side effects itself, inside `run`, by
calling `HookContext` methods (§5) — record state, queue a follow-up, write an
artifact. The engine's only obligations for the return are:

- honor `flow` — `continue` proceeds to delivery, `stop` blocks delivery and
  ends the chain, `retry` re-runs after engine-managed backoff;
- apply `payload` to the action if present;
- log / ignore `result` — never act on it.

Bindings run in `order`. A `stop` ends the chain.

## 5. HookContext — capabilities the daemon injects

```ts
interface HookContext {
  runId: string;
  workspacePath: string;
  taskId: string;
  taskStatus?: string;
  runStartedAt?: number;

  readState(key: string): unknown;
  recordState(key: string, value: unknown): void;
  queueFollowUp(targetNode: string, message: string): void;
  writeArtifact(artifact: ArtifactInput): void;
  readArtifacts(): Artifact[];
}
```

All side-effecting methods are implemented by the daemon. The hook decides
*what* to do; the daemon *executes* it through this interface. This is what
keeps the extensions package free of daemon internals.

## 6. requiredData → prompt generation

`buildRoleSection` derives a route's data contract generically: for a given
`sourceNode → targetNode / method`, union the `requiredData` of every bound hook
(built-in looked up by id, custom inline) and emit the `send_message` data
instruction from it. This removes the hardcoded `{'pr_ready','review_posted'}`
special-case and the stale-prompt drift that the gate removal surfaced.

## 7. Built-in hooks (move into `extensions/hooks`)

`pr_ready`, `review_posted`, `post_approval_only`, `pr_merged`,
`codex_review_approved` — each becomes `{ id, requiredData, run }`, with `run`
lifted from the current validator files. Seed `requiredData`:

- `pr_ready` → `[{ key:'pr_link', type:'link', required:true }]`
- `post_approval_only` → `[{ key:'pr_link', ... }, { key:'reason', ... }]`
- `review_posted`, `pr_merged`, `codex_review_approved` → their respective inputs.

## 8. What dies (no migration)

Destroy, do not migrate:

- `WorkflowHook.validator`, `classification`, and the six-variant
  `WorkflowHookResult`;
- `buildHookValidatedHandoffLines` and its hardcoded validator set;
- the welded `sourceNode` / `targetNode` / `method` on the hook object;
- the old built-in-validator registry / presets shape and the validator files.

Re-seed built-in workflows from the new binding shape. Persisted hook state is
re-seeded, not migrated.

## 9. PR sequence

1. **docs** — this spec.
2. **shared types** — `Hook`, `HookBinding`, `CustomHook`, `HookReturn`,
   `HookContext`, `DataField`; remove the old hook types.
3. **`extensions/hooks` package** — the five built-in hooks (`run` +
   `requiredData`) lifted out of the daemon.
4. **daemon engine** — `executeAction` driven off `flow` + `payload`; binding
   storage; `HookContext` implementation + injection; the script sandbox stays.
5. **built-in workflows + re-seed** — rewritten as bindings.
6. **web editor** — "define hook" vs "place binding"; `requiredData`-driven
   contract display.
7. **tests** — retire the old hook-shape suites; add chain/flow and
   prompt-generation coverage.

## 10. Operational remediation after the cutover

Two post-upgrade states need operator action. Both fail CLOSED (every
hookable action on an affected workflow is blocked; nothing runs ungated).

### Corrupt hook columns (`__corrupt_hook_bindings__`)

The repository loads a workflow whose persisted `hook_bindings`/`custom_hooks`
column cannot be decoded (bad JSON, wrong shape, or any element the
create/update validator would reject — method enum, node references, callers,
custom-hook fields) with a synthetic marker binding whose reserved id resolves
to no hook. Every hookable action stops with that diagnosable id, and
`exportWorkflow` refuses the export with a repair message.

**Remediation:** re-author the workflow's hook bindings in the visual editor
(or via `spaceWorkflow.update`), or clear them deliberately. Editor saves and
the startup restamp strip the marker before persisting — the synthetic state
can never launder itself into real configuration. Unrelated edits are NOT
wedged (the marker is filtered from validation) and leave the corrupt column
untouched, so the fail-closed protection persists until the column is healed.

### Legacy pre-v2 hooks (custom workflows)

A CUSTOM workflow whose immutable definition still carries the legacy `hooks`
array blocks every hookable action on its runs after the cutover (the
`__legacy_hooks__` guard) — there is no automatic translation, by design.
Built-in workflows migrate automatically: the startup restamp installs v2
`hook_bindings` once their runs finish (migration 197 defers the legacy-column
drop until then).

**Remediation:** archive the affected task, then either re-create the
workflow's hooks as v2 hook bindings (visual editor or `spaceWorkflow.update`,
clearing the legacy hooks) or delete and re-create the workflow. Until then
runs of that workflow stay blocked and the workflow cannot be exported.

**Known limitation (step-6 deferral):** there is no visual editor for v2 hook
bindings yet — authoring today goes through the workflow RPCs/import. The
web editor rework is tracked as the follow-up step 6 of this plan.

## 11. Deferred / out of scope

Persisted-state migration (explicitly skipped), hook versioning across spaces,
per-binding `requiredData` overrides, an editor marketplace for sharing custom
hooks.
