# Copilot CLI sessions through OXAP ACP

Status: revised proposal. Design only; no application code in this PR.

## Decision

Use the released generic ACP adapter with the official Copilot CLI. HyperNeo registers one ACP adapter per selectable model; each adapter's existing static `args` carry the model. OXAP needs only to publish the ACP native identity it already stores. No OAP field, capability, or model-switch path is added.

The [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) documents `--model=MODEL`. The [ACP contract](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) returns an opaque `sessionId` from `session/new`. It does not promise a UUID, nor do the docs prove that `--model` controls loaded sessions; those are live-proof gates below, not assumptions.

## OXAP changes

Implement the existing native-link hook in Go, Rust and Zig. Each returns `acp://sessions/<id>`, where `<id>` is the UTF-8 percent-encoding of the exact opaque ACP session ID, preserving only unreserved characters. Add shared `work.status.link` corpus cases for an ordinary ID and an ID containing slash, spaces, percent and non-ASCII text. Descriptors and capability revisions stay unchanged.

The existing hub binding already records `adapter` and `native_session_id`, and reopen requires the same adapter. The ACP subprocess is constructed per session, so two registry entries with different static args run independent CLI processes without a new adapter type.

## HyperNeo changes

Add one `oxap-copilot` row for `anthropic-copilot`, reusing saved-executable settings, readiness, the picker and admission rules. Extend hub-config inputs with the provider catalog snapshot and models stored on existing Copilot OXAP sessions. For each exact catalog ID, plus each stored ID needed to reopen an existing chat, register `anthropic-copilot:<percent-encoded model ID>` with `type: 'acp'` and exactly `args: ['--acp', '--model=<exact ID>']`. The second item is one argv value, so leading dashes cannot become options. Reject control characters and duplicate IDs; never substitute a default model.

Session open resolves an alias to the catalog's exact `ModelInfo.id`, then selects the corresponding adapter. Reopen resolves the stored model to the same stable name; the saved-model entries keep a catalog refresh from stranding a chat. Missing or ambiguous models refuse before spawn. Once `sdkSessionId` exists, reject model changes as for DeepSeek. Do not call `session.model.switch` or put `model_id` on submit.

The row's `nativeId` accepts only a canonical `acp://sessions/` link, percent-decodes it, and returns the opaque ID. It rejects invalid or non-canonical escapes and empty IDs; existing checks reject `.` and `..`. It makes no UUID assumption.

## Slice order, tests first

1. OXAP: add the failing native-link unit and shared corpus cases in all three implementations, implement them, and release. Gate the release on live CLI proof that the returned ID appears in `work.status.link`, survives in the binding log across a hub restart, and reopens to the same ID. With two static model registry entries, prove distinct argv and use `/session info` over ACP to confirm each selection on creation and reopen. Stop before HyperNeo if any identity or resume claim fails.
2. HyperNeo: add failing tests for exact per-model args and stable names, control-character refusal, two coexisting model adapters, alias resolution, catalog-refresh reopen, native-link round trips, adapter mismatch refusal, and the locked model. Implement the row and registry, then pin the proven hub release.
3. On one isolated daemon, prove SDK and OXAP Copilot chats coexist and retain their harness. On an OXAP chat prove a native tool call, streamed answer, usage when supplied, stop, close, same-ID reopen, and a contextual follow-up. Prove an unready row is disabled and creation refuses it.

## What stays unsupported versus the Copilot bridge

No Claude SDK tools, SDK tool policies or tool guards; the CLI owns its tools. No live model switch or native model catalog; HyperNeo's existing provider catalog is the only picker. No image input, premium-request/quota accounting, or cost/model-usage reporting. Portable token usage is shown when ACP supplies it, as today.

## Rejected alternative

Do not add `model_id` to `session.open.request`. That would require OAP semantics, schemas, validators, clients and fixtures across every implementation, while the existing registry argv and adapter-binding contract already preserve the selected model on restart and reopen.
