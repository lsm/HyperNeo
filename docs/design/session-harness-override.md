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

The choices for a provider and model are `sdk` (Claude Code) plus every row of
`OXAP_HARNESSES` whose `providers` includes that provider id and, when the row
lists `models`, whose `models` includes the session's model. The web filters by
provider in `SessionsPage.tsx` today; slice 5 adds the model. A new harness becomes selectable by
adding its row; nothing else lists harnesses.

A row is selectable only when it is ready for a new session: its `settings`
(the executable) are saved for that provider, its required key (`row.key`, such
as `DEEPSEEK_API_KEY`) is set, and the OXAP hub is installed. This check applies
only to the new-session dialog and to session creation; nothing else uses it.
An eligible row that is not ready still shows, disabled, with "Set up in
Settings → Providers". `sdk` is always selectable.

First batch: OpenAI Codex offers SDK and OXAP Codex; DeepSeek offers SDK and
OXAP DeepSeek. OpenCode Go with DSH is proven for Flash only (below). Each other
pair is a table row added only after that pair is proven (endpoint, auth, model
ids). Until then a pair
is simply absent from the list.

## Where the override is stored

On the session, in `config.harness`, exactly as today: absent means SDK, an
OXAP id means that harness. Creation resolves it once:

- `session.create` takes an optional top-level `harness` (not `config.harness`,
  which stays rejected and stripped from SDK query options).
- `session-lifecycle` uses `params.harness ?? newSessionDefault(provider, model)`.
  Omitted uses the model-aware new-session default, so every current caller is
  unchanged.
- The resolved value, whether requested or the default, must be `sdk` or a row
  that lists the provider (and the model, when the row lists models), and must
  be ready for a new session. Otherwise creation fails with a plain message.

A clone passes its source session's harness (`sdk` when none is stored) as
this parameter, since `buildCloneParams` strips `config.harness`. A clone keeps
the source's quota path in both directions.

No column, no table, no second field. The session record already holds the
harness, and existing code reads it from there.

## One adapter per provider, and the default changing

The hub registers one adapter per provider id, built only from providers whose
*default* is OXAP. Two things follow, and the design fixes both:

1. **Availability is separated from the default.** `buildHubConfig`
   registers an adapter, and `readKeys` in `oxap-settings.ts` loads the
   provider key, for each provider that has saved OXAP settings, whatever
   its default. Today both look only at the default, so a retained DSH adapter
   would start without `DEEPSEEK_API_KEY`. Saving the default as `sdk` keeps
   `harnessSettings` instead of dropping them (today `oxap-settings.ts`
   removes both). "Saved" means the executable settings are in the record that already holds
   them; it does not look at the key. The provider card shows the retained
   executable field whenever settings are saved, whether or not the key is set
   and even while the default is `sdk`, so a stale path can be fixed without
   flipping the default.
2. **Existing chats survive a default change.** `openGate` refuses to reopen a
   chat whose harness differs from the provider's current default ("no longer
   uses"). It instead checks that the session's harness is still saved for
   its provider. Reopening does not check the key and behaves exactly as today. Changing the default then leaves an OXAP chat usable, and an
   SDK override and a default-OXAP chat run on the same daemon.

Each provider has at most one OXAP row today, so the adapter keeps its
provider-id name and `harnessSettings` stay flat. That includes OpenCode Go
with DSH, whose first row this would be. A naming scheme for two OXAP rows on
one provider is decided only when a second pairing needs it.

## OpenCode Go with DSH, Flash only

DSH 0.2.2-rc.2 is proven on OpenCode Go for one model only: `deepseek-v4.1-flash`
answered with HTTP 200 through a DSH profile overlay that points at the Go
endpoint the daemon already uses (`OpenCodeProvider.CHAT_BASE_URL`). DSH's
built-in Go profile failed the same check, so it is not used. Matching by
provider alone would offer DSH for every Go model, so this pair adds one thing:
a row may name the models it serves.

- **The row.** `oxap-opencode-dsh`: provider `opencode`, `models:
  ['deepseek-v4.1-flash']`, key `OPENCODE_API_KEY`. Its entry starts DSH with
  `--profile sdk --patch <overlay>`. The daemon writes the overlay into its own
  state directory: one `opencode-go` provider with that endpoint, the API key read
  from `OPENCODE_API_KEY`, and that one model. The key is the OpenCode provider's
  own key, loaded for the row's `key` as for every row. `DEEPSEEK_API_KEY` is never
  set for it.
- **Selection and admission.** A row with `models` is eligible only when the
  session's model is in that list. The dialog lists it only then. `session.create`
  refuses an override to it for any other model with a plain message. A row
  without `models` is unchanged.
- **Default.** `engineForProvider` stays per provider and is unchanged. A new
  `newSessionDefault(provider, model)`, used only when a session is created,
  returns `sdk` when the saved default is a row whose `models` omit that model.
  So with this row as OpenCode's default, a Flash session uses it, and any other
  Go model gets `sdk`, today's OpenCode path. No other fallback is added. A Flash
  default passes the same readiness check as a Flash override; if it is not
  ready, creation is refused and does not fall back to `sdk`. The runtime SDK
  failover pool (`sdkFallbackProviders`) still calls `engineForProvider`, so it
  keeps excluding OpenCode while its default is this row.
- **Model change.** The thread lock that already fixes the model of a started
  DeepSeek thread (`isOxapModelLocked`, today `oxap-deepseek` only) also names
  this row. Before the first turn, a switch to a model outside the list is
  refused by the same eligibility check. The chat keeps its harness.

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

1. Availability: keep `harnessSettings` when the default is set to `sdk`;
   register adapters and load keys from saved settings; `openGate` checks
   saved, not default; the card field above. Tests: switch DeepSeek's default to SDK, then run a
   turn on an existing OXAP chat (key present); same for Codex.
2. Admission: `session.create` accepts `harness`; resolve, validate and store
   it; the ready-for-new-session check. Safe after 1 because an admitted override can
   open. Tests: default, SDK override, OXAP override on an SDK default,
   unsupported, not ready (no settings, no key).
3. Dialog: show the effective harness next to the model, list supported rows
   (disabled when not ready), send `harness` only when the user overrides.
4. Prove both first-batch pairs end to end on one daemon: provider default
   chat and SDK override chat, then the reverse.
5. OpenCode Go with DSH, Flash only: the `models` field, the row and its
   overlay, model-aware eligibility in the dialog and creation (the picker lists
   by model, and a model change that makes the chosen harness ineligible clears
   the choice and shows the model-aware default),
   `newSessionDefault`, and the row in the model lock. Tests: a Flash override
   is admitted and its first turn reaches the Go endpoint with the OpenCode key
   and no `DEEPSEEK_API_KEY`; an override for another Go model is refused; with
   the row as default, Flash uses DSH and another Go model uses `sdk`; with the
   row as default but not ready, a Flash session is refused, not moved to `sdk`;
   with the row as default, OpenCode stays out of the SDK failover pool;
   switching a DSH chat to another model is refused; in the dialog, choosing DSH
   on Flash and then another Go model shows `sdk` and submits no `harness`.
6. Later, one PR each: other pairs once each is proven.

Measuring quota use between SDK and OXAP Codex is separate work and not part
of this build.
