# OXAP harness per provider

Status: proposal. Design only; no code in this PR.

## Naming

This doc says OXAP for the protocol throughout. Code in HyperNeo today still
uses the old name OAP (`lib/oap/`, the `oapx` binary, the `HYPERNEO_OAP_*`
variables). A mechanical rename PR renames them (see "Pull requests"), and the
`HYPERNEO_OAP_*` variables are removed earlier by PR 3. Everything this design
stores or shows already says OXAP. Older stored names (the `oap` state
directory and the `oapRecovery` and `oapClearThreadId` metadata keys) keep
their names, so the rename needs no data migration.

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

**Harness:** Claude Code (default) · OXAP Claude Code · OXAP Codex · OXAP
DeepSeek · OXAP Pi · …

The provider picks the harness, and any OXAP adapter can be one. This is
not a Codex-only design. The first table rows are OXAP Claude Code, OXAP
Codex, OXAP DeepSeek and OXAP Pi. OXAP Codex is built first because its
sign-in is designed below; each other row is its own small PR (see "Adding a
harness"). The list shows only harnesses that support that provider.
Examples:

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
- Global settings gain the hub binary: its path, version and SHA-256, all
  written by the install (see "How OXAP is installed"). None is typed by hand.
  The existing `prepareOapBinary` check pins that file on every hub start.
- A session's `harness` stays creation-only. It is copied from its provider
  when the chat is created, so a later settings change never moves a running
  chat to another engine. The values are `sdk` or a harness id. Today's
  `'codex'` value becomes `oxap-codex`. Only raw-RPC test sessions ever used
  it, and no migration code is written for them.
- `harness`'s policy in `create-session-config.ts` changes from
  `creation-only` to `rejected`. Clients can no longer set it at either door.
  `session.create` and `session.update` both refuse it with the existing
  unsupported-field error. A `derived` policy would not work: create silently
  drops derived fields, and update lets them through. The daemon writes
  `harness` itself, once, after admission at create, from
  `engineForProvider(provider)`. So a chat's harness always matches its
  provider and never changes. The verify skill's OXAP scripts choose the
  provider instead, in PR 2.
- An OXAP session's adapter is its `config.provider`, which is already
  stored. Neither field changes after creation. An OXAP chat may switch models
  only within its own provider, so a cached open session can never carry
  another provider's credentials.
- PR 3 removes the five `HYPERNEO_OAP_*` variables and the `oap` block in
  `config.ts`. Settings are the only source, so what Settings shows is what runs.
  The config test and the verify skill's OXAP wire script write settings
  instead. The hub's state directory stays derived as
  `join(getDataDir(), 'oap')`.

### How OXAP is installed

HyperNeo pins one OXAP version. The daemon downloads that version's build for
its platform from the OXAP project's own GitHub release, for example
`oxap-0.1.0-alpha.33-macos-arm64.tar.gz`. It uses the file only if its
SHA-256 matches the entry in `SHA256SUMS.txt` from that same release.

The install writes the binary's path, version and hash into global settings.

There is no package-manager path. OXAP is not published on npm, PyPI or
crates.io, so the GitHub release is the only source.

This closes a gap the old path had. Today the human supplies the binary path,
version and SHA-256 by hand through the `HYPERNEO_OAP_*` env vars
(`config.ts`), and `prepareOapBinary` re-checks that hash on each hub start.
That only notices a binary swapped later; it cannot prove the first file came
from the OXAP release. Now the first download must
match the checksum that release publishes.

### Adding a harness

All harness knowledge lives in one code registry, `OXAP_HARNESSES`: a
constant TypeScript map keyed by harness id. It is not a database table, so it
needs no migration or schema change. A row says:

- its label (**OXAP Codex**) and its OXAP adapter type (`codex`);
- which provider ids may choose it;
- the extra settings it needs, such as the executable path;
- a pure function that turns a provider record into that adapter's hub entry
  (`executable`, `environment`, `model` and so on);
- a pure function that reads the harness's native session id from the hub's
  work status `link`. Codex links look like `codex://threads/<id>`;
- what input it accepts and whether it takes a thinking level. OXAP Codex
  takes text only (`oap-query-hub.ts` throws on any other block) and no
  thinking level.

Today the open, clear and reopen path knows Codex by name. `oap-reopen.ts`
checks `ref.adapter === 'codex'`, parses only `codex://threads/…` links, asks
for `capabilities` of `codex`, and its recovery notices say "Codex thread".
The daemon also compares the harness id by its literal `'codex'` value in
`session-engine.ts`, `create-session-config.ts`, `query-lifecycle-manager.ts`
(two places), `agent-session.ts` (four places), `oap-runtime.ts`, and
`query-runner.ts` (five places). In `query-runner.ts` they are the
`engine === 'codex'` run dispatch, two on its error path and two stale-query
closes. If the dispatch is missed, OXAP chats silently run on the SDK. A
mechanical rename would be wrong in all of them. For example,
`harness !== 'codex'` in `agent-session.ts` picks a fallback SDK provider, and
renamed to `!== 'oxap-codex'` it would rewrite a future OXAP DeepSeek chat's
provider.

The first PRs replace every such check:

- Engine checks become one pure `isOxapHarness(harness)`, true for any table
  id.
- Per-harness facts come from the session's row: its adapter name, its link
  parser and its label.

After that, adding a harness means adding one row and the fields it asks for.
Nothing else in the daemon or UI branches on a harness id.

Tests prove that by adding a second, synthetic row with a different link shape.
It runs open, clear and reopen on the hub's built-in `memory` adapter type,
with no new harness-id branch. Where `memory` reports no link, a fake hub
client supplies one.

The first row is `oxap-codex`:

- adapter type `codex`, for provider `anthropic-codex`;
- settings: the Codex executable;
- hub entry: `approval_policy: on-request`, `sandbox: workspace-write` and
  `any_directory`, as today's `oap-hub-config.ts` builds it. `CODEX_HOME` is
  an empty directory per provider, owned by the daemon under the state
  directory, with `cli_auth_credentials_store = "ephemeral"`. So it never
  loads or overwrites the human's own Codex login.
- `CODEX_HOME` is a path, not a key, so the entry carries it as a literal
  `CODEX_HOME=<path>` environment entry. The Go hub already accepts literal
  `NAME=value` entries (`resolveEnvironment` in `go/serve/registry.go`). Two
  providers on OXAP Codex therefore get separate homes without touching the
  shared process environment.

### How OXAP Codex signs in

The human chose to reuse HyperNeo's stored OpenAI login. Codex app-server
supports this safely with its `chatgptAuthTokens` mode:

- `account/login/start` takes only an access token and an account id.
- Codex keeps them in memory and never refreshes them itself.
- On a 401, Codex sends the host `account/chatgptAuthTokens/refresh` and waits
  10 seconds for a new access token.
- The refresh token never leaves HyperNeo. HyperNeo stays the only refresher,
  through its existing single-flight refresh, so no two programs rotate one
  login.

The tokens follow the keys rule: they never touch disk. Today's Go hub cannot
drive this mode yet:

- Its Codex adapter never sends `account/login/start`.
- It answers every server request it does not know with -32601 "unsupported
  Codex server request" (`go/adapter/codex/appserver/session.go`). That
  includes `account/chatgptAuthTokens/refresh`.

So one upstream OXAP change comes first. It adds a host-auth option on the
Codex adapter. At session start and on each refresh request, the adapter asks
the session's client for tokens through one new host interaction, and the
client answers. HyperNeo answers from its provider. The tokens travel only on
that live channel, never in the config file or the hub environment.

That request can arrive before any run exists: during `open`, or while the
chat is idle. Today nothing would hear it. `createOapRuntime` awaits
`openOapSession` before it builds the query hub. The only session
subscription is made at submit. Its `readEvent` turns any event without a
`run_id` into an `Error('Invalid OAP hub event scope')`, which fails that
run's stream. So PR 6 adds one session-level auth dispatcher:

- **Installed before open.** It subscribes to the session before `open` is
  sent and reads only the session-scoped host-auth event, with no `run_id`.
- **Ignored by the run stream.** If that event arrives mid-run, the submit-time
  subscription also sees it. PR 6 makes `readEvent` skip exactly the host-auth
  event type, so the run continues while the dispatcher answers. Any other
  event without a `run_id` stays an error, as today.
- **Provider-bound.** It answers only with tokens from the session's own
  `config.provider`, using the reply operation the upstream change defines.
  Any other request gets an error reply.
- **Timeout.** It answers within HyperNeo's existing 5-second refresh bound,
  inside Codex's 10-second wait. If refresh fails, it sends an error reply, and
  the open or run fails with "Sign in again on the OpenAI Codex provider"
  instead of hanging.
- **Cleanup.** It unsubscribes when the session closes or is deleted, and when
  the hub restarts.

PR 6 tests three cases: first login during open, refresh while idle, and a
refresh failure during startup that must end in that error, not a hang.

This needs an OAuth login on the OpenAI Codex provider. The provider can also
hold an API key instead: from `OPENAI_API_KEY` in its environment, or
imported from Codex's `auth.json`. An API key has no access token or account
id. So `decideOxapOpen` refuses that case before any open, with "OXAP Codex
needs an OpenAI sign-in, not an API key; sign in on the OpenAI Codex
provider". The harness dropdown shows the same reason.

A DeepSeek row is not written yet. The Go DeepSeek adapter takes an
executable, a `provider`, a `model` and an environment. Before that row
exists, someone must confirm that the DeepSeek harness can reach OpenCode Go's
endpoint with OpenCode Go's key.

### The hub

There is one hub process for all OXAP harnesses. Its config gets one adapter
entry per provider that chose an OXAP harness, named by the provider id. A
session opens with `adapter: <providerId>`, so two providers on the same
harness keep separate settings.

A pure function, `buildHubConfig(providerRecords, OXAP_HARNESSES)`, builds the
config. It keeps the existing posture (`docs/architecture/oap-backend-plan.md`):
the config lists only allowlisted environment variable names, never keys.
Non-secret values, such as a provider's `CODEX_HOME` path, may be literal
`NAME=value` entries.

- A key goes only into the hub process's environment, under the name its
  harness reads. The hub resolves each listed name from that environment.
- The key never touches disk. The credential store stays its only record.
- Because the environment is shared, two providers whose harnesses read the
  same variable cannot hold different values. Settings save refuses that
  combination with a reason naming both providers. Codex needs no key, so this
  never blocks it.

The config file is never written on its own. Hub start already writes
`oap-serve.json` (the `writeConfig` step in `OapEngine`'s `prepareHub`
pipeline). Each start now builds that file from the saved settings, then
launches. So the saved settings are the one record, and the file is only a
copy for that start.

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
- The Codex model list advertises thinking levels, but `session.thinking.set`
  saves the level and reports success while `applyThinking` calls only
  optional query setters (`sdk-runtime-config.ts`) that `OapQuery` lacks. So
  for a harness whose row takes no thinking level, the daemon refuses
  `session.thinking.set` before it saves (PR 2), and the UI hides the control
  (PR 7). Tests check the refusal and that the stored level is unchanged.
- For a text-only harness, PR 7 disables attach, paste and drop in the message
  input and says why. A component test covers each of the three.

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

### Restrictions the harness cannot enforce

The OXAP Codex entry fixes `approval_policy: on-request` and
`sandbox: workspace-write`. Several session settings would ask for something
else, and none of them is enforced on the OXAP path today:

- Create admission carries `permissionMode`, `tools`, `sdkToolsPreset`,
  `allowedTools`, `disallowedTools`, `maxTurns` and `maxBudgetUsd`
  (`create-session-config.ts`). The SDK path passes `sdkToolsPreset` as
  `options.tools`.
- Session create merges the global `sandbox` default with the session's own
  (`session-lifecycle.ts`), and the SDK path forwards it with its
  `filesystem.denyRead`/`denyWrite` rules.
- `codexSessionRefusal` checks only instructions, tool guards, worker
  operations, Space and Neo.
- The OXAP branch of `QueryRunner` opens the hub without them.
- A live `setPermissionMode` saves the new mode and reports success even when
  the query has no setter (`sdk-runtime-config.ts`), and `OapQuery` has none.

A chat that asked for `plan` mode would therefore get write access while
showing "plan".

PR 2 extends the admission decision to refuse what the harness cannot enforce:

- an effective `permissionMode` other than `default`. Effective means the
  session's value, else the global one, the same order
  `QueryOptionsBuilder.getPermissionMode` uses. A test covers a global `plan`
  with no session mode;
- any `tools`, `sdkToolsPreset`, `allowedTools` or `disallowedTools`;
- an effective `sandbox`, meaning the session's value merged with the global
  default exactly as session create merges it, that sets any rule;
- any `maxTurns` or `maxBudgetUsd`.

The same decision runs in four places: `session.create`, `session.update`,
the live permission change, and `session.sandbox.switch`, which writes the
sandbox through `updateSession` without `session.update` admission. For an
OXAP chat, `setPermissionMode` and `session.sandbox.switch` refuse before
they save, with "OXAP Codex runs with on-request approval in the workspace;
this restriction is not supported". Regression tests cover each restriction
at each place and check the stored config is unchanged after a refusal. Translating restrictions into
enforced OXAP policy can come later as an addition.

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
  `provider` or `model`. A same-provider update still passes. Tests send raw
  `session.update` calls covering three cases: SDK → OXAP, OXAP → SDK, and
  one OXAP provider to another on the same harness. This gate ships in PR 2,
  the same PR that derives the harness from the provider, so no build lets a
  chat store provider B while its cached hub slot still runs provider A.
- `decideOxapOpen(session, providerRecord)` gates each open. It returns the
  adapter name, or the refusal for a provider whose harness changed.
- `isOxapHarness`, `buildHubConfig`, each row's entry builder and each row's
  link parser are pure.
- `oxap.settings.save` is one pipeline. It runs read the binary identity
  (effect), then validate paths and refuse conflicting key variables (pure),
  then write settings (effect), then `OapEngine.restart()` (effect).
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
| 1 | `OXAP_HARNESSES` with the Codex row, `isOxapHarness` replacing every literal `'codex'` check (including the `query-runner.ts` dispatch), `'codex'` → `oxap-codex`, and the verify skill's OXAP wire script sends `oxap-codex` until PR 2 switches it to the provider | daemon | ~100 |
| 2 | `engineForProvider`, session create derives `harness` and refuses a client-sent one, admission refuses restrictions the harness cannot enforce (create, update, live permission change, sandbox switch) and `session.thinking.set` for a harness without thinking levels, `decideSwitch` on both doors, open/clear/reopen read link parser and label from the row while the adapter name stays the row's `codex` entry, synthetic second row in tests | daemon | ~210 |
| 3 | Hub from settings: pinned download checked against the release's `SHA256SUMS.txt`, hub-binary setting, `buildHubConfig` at hub start with one entry per provider, the adapter name switched to `config.provider` in the same PR, key names in the hub environment, `oxap.settings.save`, `OapEngine.restart()`, `decideOxapOpen`, remove the `HYPERNEO_OAP_*` vars | daemon | ~230 |
| 4 | `model_id` on submit when advertised | daemon | ~20 |
| 5 | Mechanical rename OAP → OXAP: `lib/oap/` → `lib/oxap/`, `oap-*` files and `Oap*` identifiers, the `oapx` binary name → `oxap`. The `oap` state directory and the stored session metadata keys `oapRecovery` and `oapClearThreadId` keep their names, so existing hub state and recovery state stay readable. Moves and renames only, no behavior change | daemon | rename |
| OXAP | Codex adapter host-auth option: `account/login/start` with `chatgptAuthTokens`, `account/chatgptAuthTokens/refresh` relayed as one host interaction | OXAP repo | upstream |
| 6 | Answer that interaction with the provider's current access token and account id, refreshing through the existing single-flight path. Per-provider empty ephemeral `CODEX_HOME`. Session-level auth dispatcher installed before open | daemon | ~110 |
| 7 | Harness dropdown on the provider card, hub-binary field, picker filtered by engine, thinking control hidden and attach/paste/drop disabled with a reason when the row says so | **UI** | ~170 |

Merge order is 1 → 2 → 3 → 4 → 5, then the OXAP change and a new `oxap`
release, then 6 → 7. The rename lands after PR 4 and before the UI PR. PRs 1–5
do not wait on OXAP. Only PR 7 changes what the human sees, and it lands once
sign-in works. Before it, the daemon PRs are reachable
through RPC and the verify skill. Each later
harness, starting with OXAP Claude Code, OXAP DeepSeek and OXAP Pi, is its own small PR: one table row and its fields.

## Ready today vs. waiting

Ready today, enough for PRs 1–4:

- The Go `oapx` release `v0.1.0-alpha.32` serves the Codex app-server adapter
  over stdio with open-any-directory.
- The daemon already handles hub start with a pinned binary, open and reopen,
  submit, stream, cancel, clear, recovery after a lost hub, and delete.

Limits users will see, from code that already exists:

- OXAP chats refuse system prompts, agents, tool guards, Space and Neo, and
  (from PR 2) permission modes other than `default`, tool restrictions,
  sandbox rules, turn or budget limits, and thinking levels. They accept text
  only.
- A run fails if the harness asks for a permission or asks the user a question
  (`unsupportedInteraction` in `oap-query.ts`). With Codex's `on-request` and
  `workspace-write`, ordinary edits inside the workspace do not ask.
- OXAP chats get the fallback title only when their provider cannot build an
  SDK config. That never happens for the OpenAI Codex provider.

Waiting:

- Sign-in. OXAP Codex reaches users only after the upstream host-auth change
  and an OXAP release that carries it (see "How OXAP Codex signs in").

- More harness rows. Each needs a check on how that harness takes the
  provider's key and endpoint.
- The Rust port. The Rust Codex adapter can already open, submit, stream and
  settle a run, and resolve approvals and user questions. Runtime parity
  (OXAP #1438) waits on the adapters lane reaching C8 (OXAP #1439). Switching to
  a Rust build is a new pinned version, not a design change.
- Permission and question requests. These need HyperNeo's approval UI mapped
  onto `action.permission.requested` and `user.input.requested`.

## Choices for the human

1. **How OXAP Codex signs in.** Decided: HyperNeo's stored login through
   `chatgptAuthTokens`, as above.
2. **Where the harness is chosen.** (a) Per provider now, and per model later
   if needed. (b) Per model from the start. **Recommend (a).** It covers both
   examples (OpenAI Codex, OpenCode Go) with one setting, and per model can be
   added without changing the stored shape.
