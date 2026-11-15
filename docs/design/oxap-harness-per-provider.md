# OXAP harness per provider

Status: proposal. Design only; no code in this PR.

## Naming

This doc says OXAP for the protocol throughout. Code in HyperNeo today still
uses the old name OAP (`lib/oap/`, the `oapx` binary, the `HYPERNEO_OAP_*`
variables), and a separate plan renames it. Everything this design stores or
shows already says OXAP, so that rename needs no data migration here.

Rule: every harness that runs through OXAP is shown as **OXAP <name>**
(**OXAP Codex**, **OXAP DeepSeek**) and stored with an `oxap-` prefix
(`oxap-codex`, `oxap-deepseek`).

## Problem

The daemon can already run a session through an OXAP hub with Codex as the
harness, but nothing in the UI reaches it. Today that takes five
`HYPERNEO_OAP_*` variables at daemon start (`config.ts`) and a raw
`session.create` with `config.harness: 'codex'`. No web code sets `harness`.

OXAP also hosts many harnesses besides Codex. The Go hub's registry builds
`claude`, `codex`, `acp`, `opencode`, `pi`, `copilot`, `deepseek` and `hermes`
adapters. The design should make any of them easy to add, not just Codex.

## Idea

A provider is who you sign in with and which models you get. A harness is the
agent loop that runs a turn. Today every provider runs on one harness, the
Claude Code SDK. This design adds one setting per provider:

**Harness:** Claude Code (default) · OXAP Codex · OXAP DeepSeek · …

The list shows only harnesses that support that provider. Examples:

- **OpenAI Codex** runs on Claude Code through the Responses bridge today. You
  switch it to **OXAP Codex**, and its chats run in the real Codex app-server.
- **OpenCode Go** has DeepSeek models. You switch it to **OXAP DeepSeek** once
  that harness's row exists (see "Adding a harness").

The harness is chosen per provider for now. Per-model choice can come later
without changing this shape.

## Design

### What is stored

- The provider record's `configJson` gains `harness`. A missing value means
  Claude Code, so every existing provider keeps working with no migration.
  Otherwise the value is a harness id such as `oxap-codex`.
- Global settings gain the hub binary: its path, plus the version and SHA-256
  read when the setting is saved. These are never typed by hand. The existing
  `prepareOapBinary` check pins that file on every hub start. This is trust on
  first use: it catches a file that changes later, but it does not prove the
  file is a genuine release.
- A session's `harness` stays creation-only. It is copied from its provider
  when the chat is created, so a later settings change never moves a running
  chat to another engine. The values are `sdk` or a harness id. Today's
  `'codex'` value becomes `oxap-codex`. Only raw-RPC test sessions ever used
  it, and no migration code is written for them.
- The five `HYPERNEO_OAP_*` variables and the `oap` block in `config.ts` are
  removed. Settings are the only source, so what Settings shows is what runs.
  The config test and the verify skill's OXAP wire script write settings
  instead. The hub's state directory stays derived as
  `join(getDataDir(), 'oap')`.

### Adding a harness

All harness knowledge lives in one daemon table, `OXAP_HARNESSES`, keyed by
harness id. A row says:

- its label (**OXAP Codex**) and its OXAP adapter type (`codex`);
- which provider ids may choose it;
- the extra settings it needs, such as the executable path;
- a pure function that turns a provider record into that adapter's hub entry
  (`executable`, `environment`, `model` and so on).

Adding a harness means adding one row and the fields it asks for. Nothing else
in the daemon or UI branches on a harness id.

The first row is `oxap-codex`:

- adapter type `codex`, for provider `anthropic-codex`;
- settings: the Codex executable and its `CODEX_HOME`;
- hub entry: `approval_policy: on-request`, `sandbox: workspace-write` and
  `any_directory`, as today's `oap-hub-config.ts` builds it.

A DeepSeek row is not written yet. The Go DeepSeek adapter takes an
executable, a `provider`, a `model` and an environment. Before that row
exists, someone must confirm that the DeepSeek harness can reach OpenCode Go's
endpoint with OpenCode Go's key.

### The hub

There is one hub process for all OXAP harnesses. Its config gets one adapter
entry per provider that chose an OXAP harness, named by the provider id. A
session opens with `adapter: <providerId>`, so two providers on the same
harness keep separate settings and keys.

A pure function, `buildHubConfig(providerRecords, OXAP_HARNESSES)`, builds the
config. A provider's secret goes into its own adapter entry as a literal
`NAME=value` environment entry, because the hub reads each environment name
from one shared process environment. The config file is written with mode
0600 inside the 0700 state directory.

Changing the hub binary, or any provider's harness or harness settings,
rewrites the config and calls a new `OapEngine.restart()`. Today `getHub`
throws "OAP hub configuration differs from the running hub" when the options
change, so the restart is needed. Each OXAP session then reopens its thread on
its next turn through the existing reopen path (`oap-runtime.ts`,
`oap-reopen.ts`). A run in flight at that moment ends as if the hub had been
lost, and Settings warns about that when OXAP chats are running.

### Session model picker

The provider's own model list stays. A session picks a model as usual.

- On an OXAP harness, the submit request carries `model_id` when the harness
  advertises `run.model_selection`. Go's Codex adapter does: "turn/start
  carries the model for one turn". Today the daemon's submit sends only the
  text (`oap-query-hub.ts`), so this is a small addition. A harness without that
  feature shows one entry, **Harness default**.
- The picker hides models whose provider uses a different engine than the
  session. The daemon also refuses such a switch. Without that check a switch
  silently does nothing, because `ModelSwitchHandler` never reads `harness`
  today. The refusal reads "Model switch cannot change the session engine;
  start a new chat".
- Space and Neo chats never list OXAP providers, since `codexSessionRefusal`
  refuses them.

### What the daemon calls

The OXAP run path stays as it is: `QueryRunner` → `createOapRuntime` →
`OapEngine.getHub` → `oapx serve --stdio`, then `session.open`, `submit` and
run events, translated by `oap-sdk-translator.ts`. Only three inputs change.
The adapter name comes from the session's provider, the hub config comes from
settings, and submit adds `model_id`.

SDK-only helpers still call `buildSdkConfig` on the session's provider. In
OXAP mode that provider's SDK config is still built and simply unused by the
run. So title generation, the provider listing and `providerUpstreamUrl` keep
working unchanged.

### Pipelines and pure decisions

The decisions are pure functions over recorded facts. Effects sit at the
pipeline edges.

- `engineForProvider(record)` returns `sdk` or the record's harness id.
  Session create uses it beside the existing `oap.session.admission` check.
- `decideEngineSwitch(sessionHarness, engineForProvider(target))` is a gate in
  `ModelSwitchHandler.invalidModel`, with one `result:engine` output and
  `{ value } | { reason }` arms.
- `buildHubConfig` and each harness row's entry builder are pure.
- `oxap.settings.save` is one pipeline. It runs read the binary identity
  (effect), then validate (pure), then write settings (effect), then
  `buildHubConfig` (pure), then write the hub config (effect), then
  `OapEngine.restart()` (effect).
  - If a write fails, the hub is not restarted.
  - If the restart fails, the hub is left failed and the next open starts it
    again.

### Pull requests

Each PR is cut from `dev` after the previous one merges. The line counts are
production-line estimates, sized against `oap-hub-config.ts`,
`create-session-config.ts` and `AddProviderModal.tsx`. Tests come on top.

| # | Change | Surface | Est. lines |
| --- | --- | --- | --- |
| 1 | `OXAP_HARNESSES` with the Codex row, `engineForProvider`, session create copies `harness`, `'codex'` → `oxap-codex` | daemon | ~90 |
| 2 | Hub from settings: hub-binary setting, `buildHubConfig`, `oxap.settings.save`, `OapEngine.restart()`, remove the `HYPERNEO_OAP_*` vars | daemon | ~160 |
| 3 | `model_id` on submit when advertised, and the engine gate on model switch | daemon | ~50 |
| 4 | Harness dropdown on the provider card, hub-binary field, picker filtered by engine | **UI** | ~140 |

Merge order is 1 → 2 → 3 → 4. Only PR 4 changes what the human sees. Before
it, the daemon PRs are reachable through RPC and the verify skill. Each later
harness, such as DeepSeek, is its own small PR: one table row and its fields.

## Ready today vs. waiting

Ready, and enough to ship OXAP Codex:

- The Go `oapx` release `v0.1.0-alpha.32` serves the Codex app-server adapter
  over stdio with open-any-directory.
- The daemon already handles hub start with a pinned binary, open and reopen,
  submit, stream, cancel, clear, recovery after a lost hub, and delete.

Limits users will see, from code that already exists:

- OXAP chats refuse system prompts, agents, tool guards, Space and Neo.
- A run fails if the harness asks for a permission or asks the user a question
  (`unsupportedInteraction` in `oap-query.ts`). With Codex's `on-request` and
  `workspace-write`, ordinary edits inside the workspace do not ask.
- OXAP chats get the fallback title only when their provider cannot build an
  SDK config. That never happens for the OpenAI Codex provider.

Waiting, none of it blocking this design:

- More harness rows. Each needs a check on how that harness takes the
  provider's key and endpoint.
- The Rust port. The Rust Codex adapter can already open, submit, stream and
  settle a run, and resolve approvals and user questions. Runtime parity
  (OXAP #1438) waits on the adapters lane reaching C8 (OXAP #1439). Switching to
  a Rust `oapx` is a new pin in Settings, not a design change.
- Permission and question requests. These need HyperNeo's approval UI mapped
  onto `action.permission.requested` and `user.input.requested`.

## Choices for the human

1. **How OXAP Codex signs in.** (a) Codex's own login in its `CODEX_HOME`; the
   HyperNeo provider supplies only the model list. (b) HyperNeo writes its
   stored OpenAI token into Codex's home. **Recommend (a).** With (b), two
   programs refresh one login, and they can sign each other out.
2. **Where the harness is chosen.** (a) Per provider now, and per model later
   if needed. (b) Per model from the start. **Recommend (a).** It covers both
   examples (OpenAI Codex, OpenCode Go) with one setting, and per model can be
   added without changing the stored shape.
