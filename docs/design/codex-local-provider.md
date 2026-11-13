# Codex (local) as a provider

Status: proposal. Design only; no code in this PR.

## Problem

The daemon can already run a session through Open Agent Protocol (OAP), with
Codex as the harness. Nothing in the UI reaches it. A session uses OAP only when
three conditions hold:

- the daemon started with `HYPERNEO_OAP_BINARY_PATH`, `_OAP_VERSION`,
  `_OAP_SHA256`, `_OAP_CODEX_EXECUTABLE` and `_OAP_CODEX_HOME` set
  (`packages/daemon/src/config.ts`);
- a caller passed `config.harness: 'codex'` to `session.create`, a
  creation-only field (`lib/session/create-session-config.ts`);
- the session is not a Space or Neo session and has no system prompt, agents
  or tool guards (`codexSessionRefusal` in `lib/agent/session-engine.ts`).

No web code sets `harness`. So OAP works, but only through raw RPC on a daemon
started with five environment variables.

## Naming

OAP is being renamed OXAP in a separate plan. Nothing this design stores or
shows names the protocol. The provider id, model id and label are about Codex
running locally. The protocol name stays only in code that speaks the protocol
(`lib/oap/`, the `oapx` binary), which the rename plan covers. So the rename
needs no data migration and no UI string change here.

## Design

Add one built-in provider, `codex-local`, shown as **Codex (local)**. Choosing
it is the only way to pick the Codex engine. `harness` stays a stored fact but
is derived from the provider, not set by callers.

### Settings › Add provider

`AddProviderModal.tsx` gains one quick-add entry next to **OpenAI Codex**:

| Field | Value |
| --- | --- |
| providerId | `codex-local` |
| displayName | Codex (local) |
| description | The Codex app on this machine |
| authType | `none` |

`none` is right: the Codex CLI owns its own login in its `CODEX_HOME`, and the
daemon never sees the tokens. The existing **OpenAI Codex** provider
(`anthropic-codex`) is unrelated. It bridges the Claude SDK to OpenAI's API
with its own OAuth, and it stays as it is.

Adding the provider opens a small form with the three settings the hub needs:
the `oapx` binary, the Codex executable and the Codex home. The form stores
them in the provider record's `configJson`, as `kimi` stores its region. The
binary's version and SHA-256 are read once when the form is saved and stored
beside the path. They are not typed by hand. The existing `prepareOapBinary`
check then pins exactly that file on every hub start.

The provider record is the only source. The five `HYPERNEO_OAP_*` variables and
the `oap` block in `config.ts` are removed. Their only users are the config
unit test and the verify skill's OAP wire script, and both write a provider
record instead. What the form shows is what the daemon runs.

The pin is trust on first use. It catches a binary that changes after save. It
does not prove the file is a genuine release; the human picks the file.

The provider card shows the usual status line. `getAuthStatus()` reports
"ready" when the three paths are set and the pinned binary still matches. It
reports the existing refusal text otherwise (`sha256_mismatch`,
`version_mismatch`, path not absolute).

### Session model picker

`codex-local` lists one model, **Codex default**, with id
`codex-local:default`. Codex runs whatever model its own config names.
HyperNeo does not pass a model today: the submit request carries only the text
(`oap-query-hub.ts`).

The picker follows the session's engine, because `harness` cannot change
after creation:

- When a new chat is created with a `codex-local` model, `session.create`
  derives `harness: 'codex'`.
- In a Codex session, the picker shows only `codex-local` models.
- In an SDK session, `codex-local` models are hidden.
- Space and Neo sessions never list them, since admission would refuse them.

Hiding is only the UI side. The daemon also needs a new refusal, since no
check exists today. `session.model.switch` runs through
`AgentSession.requestModelSwitch` and `ModelSwitchHandler`, and neither reads
`harness`. Without a check, a switch to `codex-local` in an SDK session would
leave it on the SDK. A switch away from `codex-local` in a Codex session would
"succeed" while Codex keeps running. `ModelSwitchHandler.invalidModel` gains
one pure decision: the target provider's engine (`codex` for `codex-local`,
`sdk` for every other provider) must equal the session's `harness`. Otherwise
the switch returns `success: false` with "Model switch cannot change the
session engine; start a new chat". The user sees why instead of getting a
silent no-op.

### What the daemon calls

Nothing new on the run path. Today's path stays:
`QueryRunner` → `createOapRuntime` → `OapEngine.getHub` spawns
`oapx serve --stdio --config <state>/oap-serve.json` with the Codex adapter
(`any_directory`, `approval_policy: on-request`, `sandbox: workspace-write`),
then `session.open.request`, `session.message.submit.request` and the run
events, translated to SDK messages by `oap-sdk-translator.ts`.

Two runtime changes:

- `createOapRuntime` reads `OapEngineOptions` from the `codex-local` provider
  record at each open, not once from startup config.
- `OapEngine` holds one hub. `getHub` throws "OAP hub configuration differs
  from the running hub" when the options change while a hub is live, and a new
  hub starts only after the old one fails or the daemon shuts down. So saving
  changed settings must also replace the hub. `OapEngine` gains `restart()`,
  which closes the current slot the same way a hub failure does. Each Codex
  session then sees `isCurrentHub` turn false and reopens its thread on its
  next turn through the existing reopen path (`oap-runtime.ts`,
  `oap-reopen.ts`). A run in flight at save time ends as if the hub had been
  lost. The Settings form says so when Codex sessions are running.

`codex-local` has no SDK config, so its `buildSdkConfig` throws. On the run
path the engine selector picks Codex first (`query-runner.ts`), so the run
never asks. Other callers reach the session's provider, and each already
catches the throw:

- `provider-service.ts` (provider listing) leaves the base URL unset.
- `agent-session.ts` (`providerUpstreamUrl`) returns no URL.
- `model-switch-handler.ts` (wire model) falls back to the plain model id, and
  the new engine check refuses those switches anyway.
- Title generation reaches it through `title-model-selection.ts` and
  `ProviderService.getEnvVarsForModel`. The throw lands in
  `SessionLifecycle.generateTitleFromMessage`, which uses its fallback title:
  the first 50 characters of the first message. A Codex chat is titled that
  way and never calls an SDK model.

## Ready today vs. waiting

Ready, and enough to ship this:

- Go `oapx` releases (latest `v0.1.0-alpha.32`) serve the Codex app-server
  adapter over stdio with open-any-directory, which the daemon already uses.
- In the daemon: hub start with a pinned binary, open and reopen, submit,
  stream, cancel, clear, recovery after a lost hub, and delete.

Limits users will see, from code that already exists:

- Codex sessions refuse system prompts, agents, tool guards, Space and Neo.
- A run fails if Codex asks for a permission or asks the user a question
  (`unsupportedInteraction` in `oap-query.ts`). With
  `approval_policy: on-request` and `workspace-write`, ordinary edits inside the
  workspace do not ask.
- One model: whatever Codex's own config selects.

Waiting on OAP work, none of it blocking this design:

- The Rust port. The Rust Codex adapter can already open, submit, stream and
  settle a run, and its approval-request slice is in review. Runtime parity
  (OAP #1438) waits on the adapters lane reaching C8 (OAP #1439). HyperNeo uses
  the Go binary and switches only when Rust ships a released `oapx` with the
  same stdio hub. That is a new pin in the form, not a design change.
- Per-run model choice. OAP defines `run.model_selection` (`model_id` per run,
  Decision 0005) and `models.list`. Using them is a later HyperNeo change: list
  Codex's models in the picker and send `model_id` on submit.
- Permission and question requests. These need HyperNeo's approval UI mapped
  onto `action.permission.requested` and `user.input.requested`.

## Choices for the human

1. **Where the hub settings live.** (a) Only in the provider record, set from
   the Add provider form; the environment variables are removed. (b) Only in
   the environment variables, and the provider appears when they are set.
   **Recommend (a).** With (b), a launchd-run daemon needs a plist edit and a
   restart to turn Codex on, which is the gap the human asked to close.
2. **Ship with one model, or wait for model choice.** (a) Ship now with
   **Codex default**, and add the model list when HyperNeo wires
   `run.model_selection`. (b) Wait and ship with a full model list.
   **Recommend (a).** Codex already picks a model from its own config, and
   model choice is purely additive later.
