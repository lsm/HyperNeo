# Codex through OAP as a provider

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

Naming: the protocol is being renamed OXAP in a separate plan. This doc uses
the names the code uses today (`oap`, the `oapx` binary). The rename does not
change this design.

## Design

Add one built-in provider, `oap-codex`, shown as **Codex (OAP)**. Choosing it
is the only way to pick the OAP engine. `harness` stays a stored fact but is
derived from the provider, not set by callers.

### Settings › Add provider

`AddProviderModal.tsx` gains one quick-add entry next to **OpenAI Codex**:

| Field | Value |
| --- | --- |
| providerId | `oap-codex` |
| displayName | Codex (OAP) |
| description | Codex app-server through an OAP hub |
| authType | `none` |

`none` is right: the Codex CLI owns its own login in its `CODEX_HOME`, and the
daemon never sees the tokens. The existing **OpenAI Codex** provider
(`anthropic-codex`) is unrelated. It bridges the Claude SDK to OpenAI's API
with its own OAuth, and it stays as it is.

Adding the provider opens a small form with the three settings the hub needs:
the `oapx` binary, the Codex executable and the Codex home. The form stores
them in the provider record's `configJson`, as `kimi` stores its region. The
binary's version and SHA-256 are read once when the form is saved and stored
beside the path. They are not typed by hand. The existing
`prepareOapBinary` check then pins exactly that file on every hub start. The
environment variables keep working and win when set, so the current test and
dev setups do not change.

The provider card shows the usual status line. `getAuthStatus()` reports
"ready" when the three paths are set and the pinned binary still matches. It
reports the existing refusal text otherwise (`sha256_mismatch`,
`version_mismatch`, path not absolute).

### Session model picker

`oap-codex` lists one model, **Codex default**, with id `oap-codex:default`.
Codex runs whatever model its own config names. HyperNeo does not pass a model
today: the submit request carries only the text (`oap-query-hub.ts`).

The picker follows the session's engine, because `harness` cannot change
after creation:

- When a new chat is created with a `oap-codex` model, `session.create`
  derives `harness: 'codex'`.
- In a Codex session, the picker shows only `oap-codex` models.
- In an SDK session, `oap-codex` models are hidden.
- Space and Neo sessions never list them, since admission would refuse them.

Hiding is only the UI side. The daemon also needs a new refusal, since no
check exists today. `session.model.switch` runs through
`AgentSession.requestModelSwitch` and `ModelSwitchHandler`, and neither reads
`harness`. Without a check, a switch to `oap-codex` in an SDK session would
leave it on the SDK. A switch away from `oap-codex` in a Codex session would
"succeed" while OAP keeps running Codex. `ModelSwitchHandler.invalidModel` gains
one pure decision: the target provider's engine (`codex` for `oap-codex`,
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

- `createOapRuntime` reads `OapEngineOptions` from the `oap-codex` provider
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

The `oap-codex` provider never builds an SDK config. Its `buildSdkConfig`
throws, and the engine selector routes the session to the OAP path before any
SDK call.

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
  settle a run, and its approval-request slice is in review. Runtime parity (OAP #1438) waits on the
  adapters lane reaching C8 (OAP #1439). HyperNeo uses the Go binary and
  switches only when Rust ships a released `oapx` with the same stdio hub. That
  is a pin change in the form, not a design change.
- Per-run model choice. OAP defines `run.model_selection` (`model_id` per run,
  Decision 0005) and `models.list`. Using them is a later HyperNeo change: list
  Codex's models in the picker and send `model_id` on submit.
- Permission and question requests. These need HyperNeo's approval UI mapped
  onto `action.permission.requested` and `user.input.requested`.

## Choices for the human

1. **Where the hub settings live.** (a) The Add provider form stores them in
   the provider record, and the environment variables still override. (b) Keep
   the environment variables only, and show the provider when they are set.
   **Recommend (a).** With (b), a launchd-run daemon needs a plist edit and a
   restart to turn Codex on, which is the gap the human asked to close.
2. **Ship with one model, or wait for model choice.** (a) Ship now with
   **Codex default**, and add the model list when HyperNeo wires
   `run.model_selection`. (b) Wait and ship with a full model list.
   **Recommend (a).** Codex already picks a model from its own config, and
   model choice is purely additive later.
