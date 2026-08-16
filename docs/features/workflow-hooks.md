# Workflow hooks

Workflow hooks replace legacy workflow gate polling for MCP action checks. They run inside the daemon before a node-agent MCP action such as `send_message`, `save_artifact`, `approve_task`, or `complete_validation_task`.

## `complete_validation_task` is opt-in

Unlike every other method above, a `complete_validation_task` hook is a **precondition for the tool to be usable at all**: the node-agent validation-completion tool rejects any workflow-backed task whose workflow does not declare an *enabled* `complete_validation_task` hook (with no `targetNode` — target scoping is send_message-only). Declaring the hook is the workflow author's explicit opt-in to the validation-only (no-PR) close path, and its `sourceNode`/`authorizedCallers` additionally name which nodes/slots may call the tool — callers the hook does not authorize are refused before the engine wrapper runs. Workflows without the hook (including PR-shaped ones gated by `pr_ready` or script validators) keep their normal completion paths. The tool is also run-backed only: standalone (run-less) tasks are rejected for every production caller. Hook results are persisted before the underlying action handler runs, so `side_effect` classification means "non-blocking pre-action side effect", not post-success handling.

## Configure hooks

Add `hooks` to a `SpaceWorkflow`:

```ts
{
  id: 'code-pr-ready',
  enabled: true,
  sourceNode: 'Coding',
  targetNode: 'Review',
  method: 'send_message',
  classification: 'validation',
  authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
  validator: { kind: 'built_in', id: 'pr_ready' },
}
```

Fields:

- `sourceNode`: workflow node name, not node ID.
- `targetNode`: workflow node name used for `send_message` target matching. Omit it for non-`send_message` methods, because those actions have no target node to compare and target-specific hooks will not match.
- `method`: MCP method that triggers hook.
- `classification`: `validation` blocks or patches action before handler; `side_effect` records state or emits follow-up after validation.
- `authorizedCallers`: fail-closed caller allowlist. Include node name and optional agent slots.
- `validator`: script validator or built-in `pr_ready` validator. Other built-in IDs exist in shared types but create/update validation rejects them until implemented.
- `retry`: retry budget for `retryable_block` results. Omit `retry` for `pr_ready` hooks so transient GitHub mergeability/check states do not become hard blocks after a small retry budget.
- `localState`: default hook state plus references to recent results from other hooks.

Unsupported today: `humanOnly: true` is present in shared types for future UI-only hook actions, but create/update validation rejects it. Do not set `humanOnly` until UI/human hook execution ships.

## Hook result contract

Validator stdout must be one JSON object:

| Result type | Effect | Banner/user-state mapping |
| --- | --- | --- |
| `allow` | Let action run. | `allowed` / no blocking banner. |
| `block` | Stop action with non-retryable reason. | `blocked_by_hook`; banner shows `reason` and `message`/`remediation` when present. |
| `retryable_block` | Queue retry until `retryAfterMs` or hook retry delay. | `waiting_on_hook_retry`; banner shows retryable block and next retry time. |
| `patch_params` | Merge `patch` into MCP params, then revalidate method schema. | `patched`; banner/debug state lists patched keys. |
| `emit_follow_up` | Dispatch follow-up message through same handler pipeline. | `follow_up_emitted`; debug state lists emitted action IDs. |
| `record_state` | Persist `state` for current hook or `stateForHook` for named hooks. | `state_recorded`; recent hook results panel shows stored result. |

Invalid JSON, unknown result type, schema-invalid patches, or script timeout become `block` results. For `send_message`, target changes from `patch_params` are ignored to prevent route hijack.

## Script execution limits and environment

Script hooks run with bounded stdout/stderr. Large params, artifacts, arrays, and objects are capped before injection into hook context so scripts cannot receive unbounded payloads. Scripts must emit compact JSON on stdout; diagnostic text belongs in `message` or stderr.

Known credential path environment variables are stripped before script execution and hooks receive an isolated temporary `HOME`. This is not a full network or filesystem sandbox: unlisted environment variables and tools may still find credentials from the host environment. Operators should only install trusted hook scripts and should not rely on hook isolation as a secret-boundary control.

## External lookup policy

Script validators must declare external lookup needs with `validator.externalLookups`. Current declared lookup value is `github`. Runtime exposes the declaration to scripts through hook context/environment but does not sandbox network access or enforce `gh --hostname`/`curl` targets for custom scripts. Built-in migration scripts self-check GitHub hosts; custom scripts must implement their own host checks and should be treated as trusted operator code.

## Human approval flow

Hooks are MCP-action based; agents satisfy handoffs by sending required data on `send_message`. Human approval remains field-gate based only for channels that still declare `gateId`. Migrated plan-approval channels remove the gate from the handoff path; Plan Review agents must include approval votes in the `send_message` payload so the approval hook can record them in hook-local state.

## Retryable block behavior

`retryable_block` does not fail workflow immediately. For `send_message` hooks, runtime persists queued action metadata, schedules retry, and rehydrates queued retries after daemon restart. Other MCP methods return retryable metadata to the caller but are not auto-queued today. Retry count resets after any non-retryable result. When attempts exceed `retry.maxAttempts`, runtime converts retryable block into hard `block` and notifies source session.

Current built-in Codex approval waits use `block` results with persisted hook-local wait metadata; agents retry the handoff after the documented delay. Use `retryable_block` only when automatic queued replay for `send_message` is desired.

## Restart recovery

On daemon restart, in-progress and blocked workflow runs are rehydrated. Hook state repository restores local state, last result, retry count, next retry time, and queued retry metadata. Done, cancelled, and pending runs are not reactivated.

Troubleshooting steps:

1. Inspect task banner for current hook status.
2. Open recent hook results in task auxiliary panel.
3. Check hook `lastResult`, `retryCount`, and `nextRetryAt` in runtime state.
4. Verify agent used correct `send_message` target and included required `data` keys.
5. For scripts, confirm stdout is valid JSON and external lookup host is allowed.

## Migration and deprecation

Legacy custom gates and poll-based progression are migrating to hooks:

- PR-ready gates become `send_message` validation hooks with `pr_ready` built-in validator.
- Approval poll scripts become validation hooks that return `record_state`, `allow`, or `block`.
- Feedback-cycle reset behavior becomes validation hooks that reset hook-local state before feedback handoff; script errors block delivery until fixed.
- Existing gate field approvals remain supported for human UI approval flows.

Deprecation path:

1. Current release: built-in workflows use hooks for PR readiness, review feedback evidence, Codex retry checks, and approval reset state updates. Legacy gates still load.
2. Next release: custom workflow save strips unsupported hook `poll` fields and warns on legacy poll configuration.
3. Later release: legacy custom-gate polls stop running by default; operators must migrate to hooks or explicit human approval gates.

Gates/polls were replaced because polling hid ownership, created daemon restart gaps, and required out-of-band state. Hooks bind validation to exact MCP action, persist result state, expose banners, and retry deterministically.