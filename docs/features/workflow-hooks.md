# Workflow hooks

Workflow hooks replace legacy workflow gate polling for MCP action checks. They run inside the daemon before or after a node-agent MCP action such as `send_message`, `save_artifact`, or `approve_task`.

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
  retry: { maxAttempts: 3, delayMs: 5000, backoffMultiplier: 1 },
}
```

Fields:

- `sourceNode` / `targetNode`: workflow node names, not node IDs.
- `method`: MCP method that triggers hook.
- `classification`: `validation` blocks or patches action before handler; `side_effect` records state or emits follow-up after validation.
- `authorizedCallers`: fail-closed caller allowlist. Include node name and optional agent slots.
- `humanOnly`: only UI/human retry actions may trigger hook.
- `validator`: built-in validator or script validator.
- `retry`: retry budget for `retryable_block` results.
- `localState`: default hook state plus references to recent results from other hooks.

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

Credential-bearing path environment variables are stripped before script execution. Do not depend on inherited config paths such as credential files. Use daemon-provided hook context and approved external lookups instead.

## External lookup policy

Script validators must declare external lookup needs with `validator.externalLookups`. Current allowlist supports `github`. GitHub lookups must only call approved GitHub hosts used by repository remotes and standard GitHub API endpoints. Custom hosts require explicit allowlist support before workflow rollout.

## Human approval flow

Hooks are MCP-action based; agents satisfy handoffs by sending required data on `send_message`. Human approval remains field-gate based where humans write gate fields through UI/RPC. Example: Plan Review writes approval votes, then approval hooks record/reset vote state as review cycles progress.

## Retryable block behavior

`retryable_block` does not fail workflow immediately. Runtime persists queued action metadata, schedules retry, and rehydrates queued retries after daemon restart. Retry count resets after any non-retryable result. When attempts exceed `retry.maxAttempts`, runtime converts retryable block into hard `block` and notifies source session.

Codex review waits use this path: hook blocks retryably while codex[bot] review is pending, retries on configured delay, and eventually allows on `+1` or blocks after timeout depending workflow script.

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
- Approval poll scripts become validation hooks that return `record_state`, `retryable_block`, or `block`.
- Feedback-cycle reset behavior becomes side-effect hooks.
- Existing gate field approvals remain supported for human UI approval flows.

Deprecation path:

1. Current release: built-in workflows use hooks for PR readiness, review feedback evidence, Codex retry checks, and approval reset side effects. Legacy gates still load.
2. Next release: custom workflow save strips unsupported hook `poll` fields and warns on legacy poll configuration.
3. Later release: legacy custom-gate polls stop running by default; operators must migrate to hooks or explicit human approval gates.

Gates/polls were replaced because polling hid ownership, created daemon restart gaps, and required out-of-band state. Hooks bind validation to exact MCP action, persist result state, expose banners, and retry deterministically.