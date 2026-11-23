# Copilot CLI sessions through OXAP ACP

Status: proposal. Design only; no application code in this PR.

## Decision

Use the released generic ACP adapter with the official Copilot CLI. Bind the HyperNeo model when the native session opens and keep that model fixed for the native thread. Do not use ACP's model catalog or `session.model.switch`.

The [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) documents `--model=MODEL`, exact UUIDs with `--session-id`, and resume by session ID. The [ACP contract](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) returns `sessionId` from `session/new`; server launch options apply to sessions it creates or loads. Thus `copilot --acp --model=MODEL` supplies the missing model path, while ACP already supplies the native identity.

## OXAP changes

Add optional `model_id` to `session.open.request`, gated by a new `session.open.model_selection` capability. An ACP registry entry may declare `model_flag`; the adapter appends that flag and `model_id` as two argv items when it spawns the per-session process. It refuses `model_id` without `model_flag`, and refuses a registry entry whose existing `args` already contain that flag. There is no default-model or slash-command fallback.

Implement the existing `native_link` adapter hook for generic ACP as `acp://sessions/<sessionId>`. This exposes the identity already returned by `session/new`; it does not invent a second ID or require a Copilot-specific adapter. Bump the ACP capability revision and release the hub.

## HyperNeo changes

Add one `oxap-copilot` row for `anthropic-copilot`, reusing the saved executable, readiness checks, picker and admission rules. Its ACP entry carries `args: ['--acp']` and `model_flag: '--model'`; its `nativeId` accepts only `acp://sessions/<canonical UUID>`.

Include the canonical session model in `session.open.request` for this row, on both open and reopen. Require a model rather than silently using the CLI default. Once `sdkSessionId` exists, reject model changes as for DeepSeek; reopen uses the stored model. Do not send `model_id` on submit and do not call `session.model.switch` for Copilot.

## Slice order, tests first

1. OXAP: add failing tests for argv containing the selected model, rejection without `model_flag` or with a duplicate flag, and `work.status.link` containing the ACP native ID. Implement, run the ACP corpus and live CLI proof, then release.
2. HyperNeo: add failing tests for the row and provider allowlist, UUID parsing and rejection of other links, model on open and reopen, no submit-time model or model switch, and a locked model after native identity is saved. Implement and pin the released hub.
3. On one isolated daemon, prove an SDK Copilot chat and an OXAP Copilot chat coexist. Open OXAP chats with two different models and use `/session info` over ACP to confirm each selection. On one chat prove a native tool call, streamed answer, usage when supplied, stop, close, reopen with the same UUID, and a follow-up that recalls context. Also prove an unready row is disabled and creation refuses it.

## What stays unsupported versus the Copilot bridge

No Claude SDK tools, SDK tool policies or tool guards; the CLI owns its tools. No live model switch or native model catalog; HyperNeo's existing provider catalog is the only picker. No image input, premium-request/quota accounting, or cost/model-usage reporting. Portable token usage is shown when ACP supplies it, as today.

## Rejected alternative

Do not register the dedicated headless Copilot adapter. It is absent from the released hub registry and its current contract lacks cancellation and native reopen. Extending the already-proven generic ACP path is smaller and preserves stop and resume.
