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

A row is selectable only when it is configured: its `settings` (the
executable) are saved for that provider and the OXAP hub is installed. An
eligible row that is not configured still shows, disabled, with "Set up in
Settings → Providers". `sdk` is always selectable.

First batch: OpenAI Codex offers SDK and OXAP Codex; DeepSeek offers SDK and
OXAP DeepSeek. OpenCode Go with DSH, then each other pair, is a table row added
only after that pair is proven (endpoint, auth, model ids). Until then a pair
is simply absent from the list.

## Where the override is stored

On the session, in `config.harness`, exactly as today: absent means SDK, an
OXAP id means that harness. Creation resolves it once:

- `session.create` takes an optional top-level `harness` (not `config.harness`,
  which stays rejected and stripped from SDK query options).
- `session-lifecycle` uses `params.harness ?? engineForProvider(provider)`.
  Omitted means the provider default, so every current caller is unchanged.
- The requested value must be `sdk` or a row that lists the provider, and must
  be configured. Otherwise creation fails with a plain message.

No column, no table, no second field. The session record already holds the
harness, and existing code reads it from there.

## One adapter per provider, and the default changing

The hub registers one adapter per provider id, built only from providers whose
*default* is OXAP. Two things follow, and the design fixes both:

1. **Availability is separated from the default.** `buildHubConfig` registers
   an adapter for each provider that has a configured OXAP harness, whatever
   its default. Saving the default as `sdk` keeps `harnessSettings` instead of
   dropping them (today `oxap-settings.ts` removes both). Configured means
   "settings saved", so it is derived from the record that already holds it.
2. **Existing chats survive a default change.** `openGate` refuses to reopen a
   chat whose harness differs from the provider's current default ("no longer
   uses"). It instead checks that the session's harness is still configured for
   its provider. Changing the default then leaves an OXAP chat usable, and an
   SDK override and a default-OXAP chat run on the same daemon.

With one OXAP row per provider (the first batch) the adapter keeps its
provider-id name and `harnessSettings` stay flat. When a provider gets a second
OXAP row (OpenCode Go), that slice keys the settings and the adapter name by
harness id. This design does not build that early.

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

1. Admission: `session.create` accepts `harness`; resolve, validate and store
   it; the configured check. Daemon tests: default, SDK override, OXAP override,
   unsupported, unconfigured.
2. Availability: keep `harnessSettings` when the default is set to `sdk`;
   register adapters from configured settings; `openGate` checks configured, not
   default. Tests: change the default, reopen an existing OXAP chat.
3. Dialog: show the effective harness next to the model, list supported rows
   (disabled when unconfigured), send `harness` only when the user overrides.
4. Prove both first-batch pairs end to end on one daemon: provider default
   chat and SDK override chat, then the reverse.
5. Later, one PR each: OpenCode Go with DSH (needs keyed settings), then other
   pairs once each is proven.

Slice 1 and 2 may be reordered; 3 needs both. Measuring quota use between SDK
and OXAP Codex is a separate piece of work and not part of this build.
