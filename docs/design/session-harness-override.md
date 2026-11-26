# Harness override for one new session

Status: proposal. Design only; no code in this PR.

## Decision

A provider keeps its default harness (`harness` in the provider record's
`configJson`, set in Settings → Providers). The new-session dialog shows the
effective harness and lets the user pick another one for that session only.
The override never changes the provider default or any existing chat.

Nothing new is added to the model. The list, the check and the stored value all
reuse what exists.

## Where the list comes from

The choices for a provider are `sdk` (Claude Code) plus every row of
`OXAP_HARNESSES` whose `providers` includes that provider id. The web already
filters this way in `SessionsPage.tsx`. A new harness becomes selectable by
adding its row; nothing else lists harnesses.

A row is selectable only when it is ready for a new session: its `settings`
(the executable) are saved for that provider, its required key (`row.key`, such
as `DEEPSEEK_API_KEY`) is set, and the OXAP hub is installed. This check applies
only to the new-session dialog and to session creation; nothing else uses it.
An eligible row that is not ready still shows, disabled, with "Set up in
Settings → Providers". `sdk` is always selectable.

First batch: OpenAI Codex offers SDK and OXAP Codex; DeepSeek offers SDK and
OXAP DeepSeek; OpenCode Go offers SDK and DSH (below). A harness applies to the
whole provider. HyperNeo does not check which of the provider's models a
harness handles; that is between the provider and the user. Each other pair is
a table row added when it is wired up.

## Where the override is stored

On the session, in `config.harness`, exactly as today: absent means SDK, an
OXAP id means that harness. Creation resolves it once:

- `session.create` takes an optional top-level `harness` (not `config.harness`,
  which stays rejected and stripped from SDK query options).
- `session-lifecycle` uses `params.harness ?? engineForProvider(provider)`.
  Omitted means the provider default, so every current caller is unchanged.
- The requested value must be `sdk` or a row that lists the provider, and must
  be ready for a new session. Otherwise creation fails with a plain message.

A clone passes its source session's harness (`sdk` when none is stored) as
this parameter, since `buildCloneParams` strips `config.harness`. A clone keeps
the source's quota path in both directions.

No column, no table, no second field. The session record already holds the
harness, and existing code reads it from there.

## One adapter per provider, and the default changing

The hub registers one adapter per provider id. Two rules make an override
safe; both are in place:

1. **Availability is separate from the default.** `buildHubConfig` registers
   an adapter, and `readKeys` in `oxap-settings.ts` loads its key, for each
   provider with saved OXAP settings, whatever its default. Saving the default
   as `sdk` keeps `harnessSettings`. "Saved" means the executable settings are
   in the provider record; it does not look at the key.
2. **Existing chats survive a default change.** `openGate` reopens a chat
   against the harness saved for its provider, not the current default, and
   does not check the key. An SDK override and a default-OXAP chat run on the
   same daemon.

Each provider has at most one OXAP row today, so the adapter keeps its
provider-id name and `harnessSettings` stay flat. That includes OpenCode Go
with DSH, whose first row this would be. A naming scheme for two OXAP rows on
one provider is decided only when a second pairing needs it.

## OpenCode Go with DSH

One new row, `oxap-opencode-dsh`: provider `opencode`, key `OPENCODE_API_KEY`.
It is chosen like any other row, as OpenCode's default in Settings or as a
per-session override.

- **Launch.** The entry has the same DSH adapter `type` as `oxap-deepseek`,
  with DSH's native `provider: 'opencode-go'` and a fixed start model, which
  the per-submit switch below replaces. It starts DSH with `--profile sdk --patch
  <overlay>`, because DSH's built-in Go profile does not reach the Go endpoint.
  The daemon writes the overlay into its own state directory: the
  `opencode-go` provider at the endpoint the daemon already uses
  (`OpenCodeProvider.CHAT_BASE_URL`), with the key read from
  `OPENCODE_API_KEY`. The entry sets neither `model_provider` nor
  `model_endpoint`, since the hub's routing for those sets `DEEPSEEK_API_KEY`
  in the child.
- **Selected model.** The session's model reaches DSH the way it already does
  for `oxap-deepseek`: before each submit, `oxap-query-hub.ts` sends
  `session.model.switch` with the session's model and waits for the
  confirmation. Today that binding runs only when the adapter id is
  `deepseek`; it runs for every DSH row instead (by harness row, not adapter
  id), so it also covers this row, whose adapter id is `opencode`.
- **Key.** It is the OpenCode provider's own key, resolved as the provider
  resolves it (`OpencodeProvider.getApiKey`: `OPENCODE_API_KEY`, then
  `OPENCODE_GO_API_KEY`, then the stored credential). That resolution goes into
  the shared OXAP key callback (`app.ts`), which feeds readiness, creation and
  the hub launch, so a setup that works today is ready. `DEEPSEEK_API_KEY` is
  never set for it.

## What happens when the harness is not installed

- Dialog: the row is disabled with the Settings hint above. The user cannot
  submit it.
- Daemon: creation re-checks, because the dialog can be stale (hub removed,
  executable deleted). It refuses before the session exists, with the existing
  text "OXAP hub is not installed; choose an OXAP harness in Settings" or the
  missing-setting reason. No half-created session, and no silent fall back to
  SDK, since that would spend a different quota than the user chose.
- A run that later fails to start (binary gone) surfaces the existing OXAP
  error on that chat. The chat keeps its harness.

Creation keeps its existing admission checks (`codexSessionRefusal`,
`thinkingRefusal`) against the resolved harness, so the override cannot skip
them.

## Slices

Each slice works on its own: nothing is reachable before what it needs exists.

1. Availability (in place): saved settings register adapters and load keys,
   an `sdk` default keeps them, and `openGate` checks the saved harness.
2. Admission: `session.create` accepts `harness`; resolve, validate and store
   it; the ready-for-new-session check. Safe after 1 because an admitted override can
   open. Tests: default, SDK override, OXAP override on an SDK default,
   unsupported, not ready (no settings, no key).
3. Dialog: show the effective harness next to the model, list supported rows
   (disabled when not ready), send `harness` only when the user overrides.
4. Prove the OpenAI Codex and DeepSeek pairs end to end on one daemon:
   provider default chat and SDK override chat, then the reverse.
5. OpenCode Go with DSH: the row, its overlay, the model binding by row, and
   the key in the shared callback. Tests: a DSH session on OpenCode reaches
   the Go endpoint with the OpenCode key and no `DEEPSEEK_API_KEY`, and the
   outbound request carries the session's selected model; a key set only as
   `OPENCODE_GO_API_KEY` makes the row ready and reaches DSH as
   `OPENCODE_API_KEY`.
6. Later, one PR each: other pairs.

Measuring quota use between SDK and OXAP Codex is separate work and not part
of this build.
