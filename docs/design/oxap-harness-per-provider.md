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
- An OXAP session's adapter is its `config.provider`, which is already
  stored. Neither field changes after creation. An OXAP chat may switch models
  only within its own provider, so a cached open session can never carry
  another provider's credentials.
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
  (`executable`, `environment`, `model` and so on);
- a pure function that reads the harness's native session id from the hub's
  work status `link`. Codex links look like `codex://threads/<id>`.

Today the open, clear and reopen path knows Codex by name. `oap-reopen.ts`
checks `ref.adapter === 'codex'`, parses only `codex://threads/…` links, asks
for `capabilities` of `codex`, and its recovery notices say "Codex thread".
The first PR moves each of these onto the session's adapter name and its row:
the row's link parser and its label. After that, adding a harness means adding
one row and the fields it asks for. Nothing else in the daemon or UI branches
on a harness id.

Tests prove that by adding a second, synthetic row with a different link shape.
It runs open, clear and reopen on the hub's built-in `memory` adapter type,
with no new harness-id branch. Where `memory` reports no link, a fake hub
client supplies one.

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
from one shared process environment.

The config file is never written on its own. Hub start already writes
`oap-serve.json` (the `writeConfig` step in `OapEngine`'s `prepareHub`
pipeline). Each start now builds that file from the saved settings, writes it
with mode 0600 inside the 0700 state directory, then launches. So the saved
settings are the one record, and the file is only a copy for that start.

At-rest rule: provider keys stay only in the credential store. The file is
the one place a key is written in plain text, so it never outlives a start:

- The Go hub reads its config once, in `LoadRegistry`, before it serves.
- The daemon deletes the file as soon as the hub answers its first request.
  The client's `connect()` resolves at spawn, before the hub has read the
  file, so connect alone is not enough.
- Each start also deletes any file a crash left behind before writing the new
  one.
- So a key sits on disk only between the write and the hub's first answer.
  Rows without secrets, like Codex, never write one.

Changing the hub binary, or any provider's harness or harness settings, saves
settings and then calls a new `OapEngine.restart()`. Today `getHub` throws
"OAP hub configuration differs from the running hub" when the options change,
so the restart is needed. Each OXAP session then reopens on its next turn
through the existing reopen path.

What happens to existing chats on a provider's change:

- **Same harness, new settings or key:** the chat reopens its native thread on
  the new hub with the new settings.
- **Different harness, or back to Claude Code:** the chat's stored harness no
  longer matches its provider. The open decision refuses it with "This chat
  ran on OXAP Codex, which this provider no longer uses; start a new chat".
  The chat never sends an old thread id to another harness, and it never
  reopens against a removed adapter.

A run in flight at restart time ends as if the hub had been lost. Settings
warns about that when OXAP chats are running.

### Session model picker

The provider's own model list stays. A session picks a model as usual.

- On an OXAP harness, the submit request carries `model_id` when the harness
  advertises `run.model_selection`. Go's Codex adapter does: "turn/start
  carries the model for one turn". Today the daemon's submit sends only the
  text (`oap-query-hub.ts`), so this is a small addition. A harness without that
  feature shows one entry, **Harness default**.
- The picker hides models the session cannot switch to. An SDK chat sees no
  OXAP providers. An OXAP chat sees only its own provider's models. The daemon
  also refuses those switches. Without that check a switch silently does
  nothing, because `ModelSwitchHandler` never reads `harness` today. The
  refusal reads "This chat's harness and provider are fixed; start a new
  chat".
- Space and Neo chats never list OXAP providers, since `codexSessionRefusal`
  refuses them.

### What the daemon calls

The OXAP run path stays as it is: `QueryRunner` → `createOapRuntime` →
`OapEngine.getHub` → `oapx serve --stdio`, then `session.open`, `submit` and
run events, translated by `oap-sdk-translator.ts`. Four inputs change:

- the adapter name comes from the session's provider;
- `decideOxapOpen` gates each open;
- the hub config comes from settings;
- submit adds `model_id`.

SDK-only helpers still call `buildSdkConfig` on the session's provider. In
OXAP mode that provider's SDK config is still built and simply unused by the
run. So title generation, the provider listing and `providerUpstreamUrl` keep
working unchanged.

### Pipelines and pure decisions

The decisions are pure functions over recorded facts. Effects sit at the
pipeline edges.

- `engineForProvider(record)` returns `sdk` or the record's harness id.
  Session create uses it beside the existing `oap.session.admission` check.
- `decideSwitch(session, targetProvider, engineForProvider(target))` is a gate
  in `ModelSwitchHandler.invalidModel`, with one `result:switch` output and
  `{ value } | { reason }` arms. An SDK chat may not move to an OXAP provider.
  An OXAP chat may not change its provider. The same decision also guards the
  other door: raw `session.update` can write `config.provider`, because
  `provider` is an updatable field in `create-session-config.ts`. So
  `admitUpdateSessionConfig` calls `decideSwitch` whenever the update sets
  `provider` or `model`.
- `decideOxapOpen(session, providerRecord)` gates each open. It returns the
  adapter name, or the refusal for a provider whose harness changed.
- `buildHubConfig`, each row's entry builder and each row's link parser are
  pure.
- `oxap.settings.save` is one pipeline. It runs read the binary identity
  (effect), then validate (pure), then write settings (effect), then
  `OapEngine.restart()` (effect).
  - The settings write is the only commit. If it fails, nothing changed.
  - `restart()` first marks the current hub slot failed. That is an in-memory
    flag and cannot fail. Only then does it close the slot.
  - So once settings are saved, no live hub can be reused. The next open
    starts a hub, and its `prepareHub` builds and writes the config file from
    the saved settings.
  - If closing the old hub, writing the file or launching fails, that start
    fails. The next open retries from the same saved settings, with no second
    save needed. A daemon restart lands in the same state.
  - Failure-injection tests cover each step after the settings write. They
    check that the saved settings, the hub that next opens, and the session's
    reopen all agree.

### Pull requests

Each PR is cut from `dev` after the previous one merges. The line counts are
production-line estimates, sized against `oap-hub-config.ts`,
`create-session-config.ts` and `AddProviderModal.tsx`. Tests come on top.

| # | Change | Surface | Est. lines |
| --- | --- | --- | --- |
| 1 | `OXAP_HARNESSES` with the Codex row, `engineForProvider`, session create copies `harness`, `'codex'` → `oxap-codex`, open/clear/reopen read adapter name and link parser from the row, synthetic second row in tests | daemon | ~150 |
| 2 | Hub from settings: hub-binary setting, `buildHubConfig` at hub start, `oxap.settings.save`, `OapEngine.restart()`, `decideOxapOpen`, remove the `HYPERNEO_OAP_*` vars | daemon | ~170 |
| 3 | `model_id` on submit when advertised, and the switch gate | daemon | ~50 |
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
