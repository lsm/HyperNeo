# Providers Area Survey + Bug Hunt — Chain Proposals (task #1258)

Date: 2026-08-22. Base: `origin/dev` @ `e87cadcd7`. Analysis only — no production
code changed. Paths abbreviated: **D** = `packages/daemon/src`, **W** =
`packages/web/src`. All line numbers verified against the base commit. Taxonomy
references (P1–P8, `requestRun`, `decisionRun`) follow ADR 0004
(`docs/adr/0004-superpipe-decision-pipelines.md`).

Owner-reported pain investigated:

1. ACUTE — "sometimes the entire provider will be gone, and I have to
   disable/re-enable to get it back."
2. ACUTE — "most of the time, if I refresh the provider page, we just get errors."
3. FEATURE GAP — dynamic model discovery + per-provider curation.

---

## ACUTE FIX 1 — "Entire provider gone, only disable/re-enable recovers"

**Root cause: three stacked defects + one UI amplifier.** The enable toggle is
the *only* code path that (1) constructs a **fresh provider instance**
(`ensureBuiltInProviderRegistered`, D`lib/providers/factory.ts:230-270`),
(2) force-applies stored credentials with `isStartupSync=false`, bypassing the
startup skip (D`lib/providers/provider-sync.ts:67-77`, called from
D`lib/rpc-handlers/provider-handlers.ts:357-364`), and (3) runs the **global**
`clearModelsCache()` which is the only clearer of `refreshedMissingProviders`
(D`lib/rpc-handlers/provider-handlers.ts:176-182` → D`lib/model-service.ts:256-276`).
Each defect below is stuck until one of those three things happens.

### Cause A (worst, provider-level): codex bridge caches a permanent negative auth result

- `getBridgeAuth()` sets `this.cachedBridgeAuth = null` when both
  `loadCredentials()` and `importFromCodexAuth()` come up empty
  (D`lib/providers/anthropic-to-codex-bridge-provider.ts:265`), and the early
  return at `:244-245` treats `null` as resolved — **no TTL, no re-read for the
  process lifetime**. Later-appearing `~/.hyperneo/auth.json` /
  `~/.codex/auth.json` credentials are never picked up.
- Amplifier: at startup, if the provider's own `getCredentials()` is null,
  `syncProviderToRegistry` **skips** applying stored credentials ("Skipping
  stale stored credentials", D`lib/providers/provider-sync.ts:68-74`) — so
  nothing ever calls `setCredentials` to clear the null. The import comes up
  empty only when the credential files are genuinely absent/unusable:
  `~/.codex/auth.json` missing or unparseable (`:856-861`), or holding neither
  `OPENAI_API_KEY` nor `tokens.access_token` (`:863, :876`). A transient
  failure of the in-import token refresh does **not** trigger the null —
  `refreshCodexToken` catches network/timeout errors and returns
  `{ok:false}` (`:101-104`), after which the import deliberately retains the
  existing `access_token` (`:878-913`). So the null sticks when credentials
  don't exist *yet* at first `isAvailable()`/`getModels()` call — e.g. before
  the user completes codex CLI login or an OAuth flow in another window — and
  later-appearing files are never re-read.
- Effect: `isAvailable()` false forever (`:171-173`) → `providers.list` shows
  unavailable (D`lib/rpc-handlers/provider-handlers.ts:193`), models `[]`,
  picker hides the whole provider.
- Toggle fixes it exactly: a fresh instance re-reads both files unconditionally.
  This is the tightest match to the owner's wording.

### Cause B (picker-level, any provider): stranded-provider recovery is one-shot and permanent

- `modelsCache` is built at daemon start (D`lib/model-service.ts:220-245`) or
  after any provider mutation, via `loadModelsFromProviders` (`:173-198`). If a
  provider's `getModels()` rejects while others succeed, its models are
  silently absent (allSettled drops them).
- On the next `models.list`, `detectStrandedProviders` gives each missing
  provider **exactly one** 3s probe, marking it attempted *before* probing
  regardless of outcome (D`lib/rpc-handlers/session-handlers.ts:56-80`, mark at
  `:67`). `refreshedMissingProviders` (D`lib/model-service.ts:110`) is cleared
  **only** by the global `clearModelsCache()` (`:274`) — i.e. by provider
  create/update/delete, auth login/refresh (and logout, via the same helper,
  D`lib/rpc-handlers/auth-handlers.ts:27-32,139,289`), settings changes
  touching custom endpoints or allowlists
  (D`lib/rpc-handlers/settings-handlers.ts:103-112,181-188`), or the
  `models.clearCache` RPC (D`lib/rpc-handlers/session-handlers.ts:812-815`).
  Session-scoped cache clears don't touch it. A forced
  `models.list {forceRefresh:true}` (the Models settings refresh button)
  bypasses the marker entirely by calling `refreshModels` directly — manual
  recovery paths exist; what's missing is any **automatic** retry.
- The shrink-guard in `refreshModels` (`:320-324`) is **not** the re-entry
  blocker: it only keeps a *currently cached* provider listed when a degraded
  refresh returns fewer models — recovery makes the merged list larger, the
  `previousModels.length > mergedModels.length` condition is false, and the
  recovered list installs. What blocks re-entry is that the one-shot marker
  means no refresh runs at all on ordinary cached requests, leaving the 4-hour
  TTL background refresh (`:27`, `:200-204`) as the only automatic path —
  "never" to a user sitting at the picker.

### Cause C (why models go missing at build time): seven providers throw out of `getModels()` on transient upstream failure

`getModels()` doubles as a **live credential probe** and throws on any non-ok
response (incl. **429** — exactly GLM's documented concurrency-limit case, ADR
Roadmap Phase 2):

- GLM: probe POST then throw — D`lib/providers/glm-provider.ts:182-187`
  (probe `:159-180`)
- Kimi: D`lib/providers/kimi-provider.ts:314-335`
- DeepSeek: D`lib/providers/deepseek-provider.ts:119-124`
- MiniMax: D`lib/providers/minimax-provider.ts:137-142`
- ACP: subprocess probe throws — D`lib/providers/acp-provider.ts:205-226`
  (`verifyCommandAvailable` `:188-203`)
- Codex bridge: D`lib/providers/anthropic-to-codex-bridge-provider.ts:491-496`
- Custom endpoints: `probeEndpoint()` throws with no catch —
  D`lib/providers/custom-endpoint-provider.ts:183-186`

So: the daemon restarts (or any provider is edited) while Z.ai is 429ing → the
cache is rebuilt without GLM → the one-shot stranded retry is consumed while
still 429ing → GLM is invisible in every picker for up to 4h despite
`isAvailable()=true` on the provider page. Toggle = instant recovery.

### UI amplifier

`filterModelsForPicker` hides **all** models of any provider whose
`auth.providers` status is `isAuthenticated:false`
(W`hooks/useModelSwitcher.ts:194-205`) — a transient auth-status false
(per-provider catch returns false on error,
D`lib/rpc-handlers/auth-handlers.ts:93-101`) blanks a provider from pickers,
and **no consumer re-polls auth status after such a failure**
(`NewChatModelPicker` loads only on connection change; `SessionStatusBar` on
mount/`providers.changed`), so the hide persists until reconnection, a
`providers.changed` event, or a provider mutation. Fix placement: C2-PR2(e).

### Proposed minimal fix chain (C1), pilot-style

| PR | Scope | Pins / changes |
| --- | --- | --- |
| **C1-PR1 (pin)** | Daemon characterization tests | Pin current behavior: (a) cache built while GLM probe rejects → GLM models absent from `modelsCache`; (b) the stranded probe suite already pins the one-shot no-retry (`session-handlers.test.ts:322+`) — extend it with the missing transition: upstream recovers, yet later cached `models.list` calls perform no further probe until a global clear; (c) `providers.update` disable→enable → global cache clear + attempted-set clear → recovery. Files: extend D`tests/unit/1-core/core/model-service.test.ts` (retry tracking `:71-93`), D`tests/unit/2-handlers/rpc-handlers/session-handlers.test.ts` (`:278,322+`), and D`tests/unit/2-handlers/rpc-handlers/provider-handlers.test.ts`. Plus a codex pin: `getBridgeAuth` null (credentials absent at first call) → later file appearance is not re-read. |
| **C1-PR2 (fix, model-service)** | Decouple listing from probing | In `loadModelsFromProviders` (model-service.ts:183-189): when `isAvailable()=true` and `getModels()` **rejects or returns an empty list**, fall back in two steps — first `provider.getCachedModels?.()`, then the provider's static metadata (`STATIC_MODEL_METADATA` already exists, `:65-71`; Minimax missing from it — add; copilot is missing too: its `getModels()` catches embedded-server start failure and returns `[]` rather than rejecting — copilot `provider.ts:241-245` — and the static seam holds only the 1-entry legacy overlay, so its 7-entry `COPILOT_ANTHROPIC_MODELS` (copilot `provider.ts:56-134`, exported for this) must be added). The empty-result case matters for the same reason as the rejection case: an available provider yielding no models is a failed fetch, not a real empty catalog. The cached-models step is the ACP fallback: ACP has no static entry by design (its list is per-command and dynamic), but its curated `config_json.models` is hydrated into `cachedModels` at startup sync (acp-provider.ts:137-173, 233-235), so a failed subprocess probe still lists the curated set; an empty configured `models: []` also maps to the synthetic default (acp-provider.ts:164-167). The command-only case — no `models` key, so `parseAcpConfig` yields `undefined` (provider-sync.ts:21-33) and `setAcpModels(undefined)` leaves `cachedModels` null (acp-provider.ts:169-172) — needs one extra step: `getCachedModels()` must synthesize the default entry when `cachedModels` is null but a command identity is configured, mirroring the healthy `getModels()` tail (acp-provider.ts:221-225) and the null branch of `updateAcpModelCache` (acp/acp-query-runner.ts:1112-1118), which already splices that same synthetic default into the global cache — so the synthesis is behavior-consistent with both existing consumers. Custom endpoints likewise have no static entry; a two-line `getCachedModels()` returning their configured `config.models` covers them, since the probe only verifies a list that is config, not discovery (custom-endpoint-provider.ts:183-186). Single seam, no provider-specific branches beyond that accessor. Tradeoff (flag in PR): with the fallback, a failing provider stays listed and selectable — and as written nothing surfaces the failure: the probe-based providers' `getAuthStatus()` checks only key *presence* (glm-provider.ts:150-157, kimi/deepseek/minimax likewise), the probe rejection is dropped by `allSettled`, and `loadModelsFromProviders` writes no health status, so an invalid-key provider looks authenticated and healthy until a real request fails. The fix must therefore propagate the failure recorded by C1-PR3(c)'s failure set into `getAuthStatus` using C2-PR2(e)'s `errorKind`: probe 401/403 → `'credential'` (picker hides the provider, matching the definitive-hide rule), 5xx/timeout/network → `'transient'` (models stay listed via the fallback, provider shown degraded). |
| **C1-PR3 (fix, retry + TTL)** | Make recovery self-healing | (a) Replace the `refreshedMissingProviders` Set with timestamped attempts + retry backoff (e.g. 60s) — do **not** clear markers on every refresh completion: a provider whose `isAvailable()` stays true while `getModels()` keeps failing would be re-detected as stranded on every cached `models.list`, re-probing and re-triggering an upstream refresh (hammering an already failing or rate-limited service); clearing a provider's marker is safe only when that provider actually recovered in the refresh; (b) codex `cachedBridgeAuth=null` gets a TTL (5 min, matching copilot's `tokenCache` pattern) or re-checks on auth.json mtime change; (c) once C1-PR2's fallbacks populate the cache with the failed provider's models, `detectStrandedProviders` considers that provider present and never creates a retry attempt for it — so the failure must be recorded by `loadModelsFromProviders` itself (return a per-provider failure set alongside the models, tracked with the same backoff timestamps and retried independently of cache presence), leaving the stranded-probe path only for providers absent from the cache entirely. Re-run PR1 pins inverted: GLM present via fallback during probe failure; codex re-reads after credentials appear. |

**ADR classification:** C1-PR2 is a P3 guard + fallback at one seam; C1-PR3a is
a small decision ("probe / skip / retry") that fits `decisionRun` but is too
small to justify a pipeline — keep inline per the hot-path/simplicity rule.

---

## ACUTE FIX 2 — "Refreshing the provider page usually gives errors"

**Root cause: a mount-vs-WebSocket race with a terminal error state (web),
stacked on daemon-side network I/O under a 10s RPC timeout.**

1. **Primary (web race):** `App` renders synchronously and `initializeRouter()`
   mounts `ProvidersSettings` in the same tick, while the WS connect is still
   pending (W`App.tsx:64-92`, `islands/MainContent.tsx:408`). The mount effect
   fires `loadProviders()` immediately
   (W`components/settings/ProvidersSettings.tsx:107-109`);
   `getHubOrThrow()` throws `ConnectionNotReadyError` while connecting
   (W`lib/api-helpers.ts:35-41`; `hub.request` throws 'Not connected to
   transport', `packages/shared/src/message-hub/message-hub.ts:179-181`). The
   bare catch only toasts (`:100-101`) → misleading "No providers configured."
   empty state (`:415-420`). **No retry, no refetch on connect, no
   `providers.changed` subscription** — failure is terminal. Auth-expiry
   redirects land on this very page
   (W`lib/connection-manager.ts:165-176`), guaranteeing the losing race.
2. **Secondary (daemon latency):** `providers.list` awaits
   `provider.isAvailable()` per record
   (D`lib/rpc-handlers/provider-handlers.ts:187-201`) under the 10s default
   request timeout (`message-hub.ts:83,193-199`). Two implementations do real
   network/subprocess work: ollama local fetches `/api/tags` **without a
   timeout** (D`lib/providers/ollama-provider.ts:105-120`) — a wedged server
   hangs the listing; copilot's `isAvailable` can spend ~25s (gh CLI 5s +
   `validateCopilotToken` subprocess 20s,
   D`lib/providers/anthropic-copilot/provider.ts:449-544`) when
   unauthenticated. → `Request timeout: providers.list`.
3. **Aggravator (web races):** `loadProviders` has no generation guard and no
   in-flight dedupe (`:74-105`); the 2s OAuth poll (`:111-125`) and
   post-action reloads interleave last-resolved-wins. The guarded reference
   implementation already exists (`useFetchModels.ts:15,36,56,63,69-71`);
   `ModelsSettings.fetchModels` (W`components/settings/ModelsSettings.tsx:466-485`)
   silently returns when the hub is missing.

### Proposed minimal fix chain (C2)

| PR | Scope | Pins / changes |
| --- | --- | --- |
| **C2-PR1 (pin, web)** | Characterization tests | Mount while disconnected → `listProviders` rejects with `ConnectionNotReadyError` → error toast + empty state, and (pin) a later successful connect performs **no** refetch. Extend W`components/settings/__tests__/ProvidersSettings.test.tsx` (already pins the rejection toast `:586-594`). |
| **C2-PR2 (fix, web)** | Connect-then-fetch + liveness | (a) `loadProviders` gates on `connectionManager.onceConnected(...)` (W`lib/connection-manager.ts:111-127` — runs immediately when connected, otherwise on the next connect event) rather than `await getHub()`: the cached `connectionPromise` stays resolved after the first successful connection, so during a reconnect `getHub()` can return an already-resolved promise while `transport.isReady()` is false, leaving the request still throwing with no event to recover on; (b) subscribe to `providers.changed` (idiom already used by W`components/SessionStatusBar.tsx:207-216` and W`hooks/useModelSwitcher.ts:278-287`); (c) generation guard per `useFetchModels`; (d) durable error state + Retry button instead of the silent empty state; (e) `filterModelsForPicker` must not hide a provider on a *transient* auth failure — but `error` presence alone is the wrong predicate, because every provider's normal unauthenticated state also carries an error ("Set GLM_API_KEY…", glm-provider.ts:150-157, "Not logged in…", copilot `provider.ts:331-355`); add an explicit transient signal to the auth status (e.g. `errorKind: 'transient' \| 'credential'` on `ProviderAuthStatusInfo`, stamped `'transient'` only by the catch-all error path at auth-handlers.ts:93-101 and probe-failure paths, `'credential'` by the definitive key-absence/rejection states) and hide only on the definitive kind — since no consumer re-polls auth status after a transient failure (the ACUTE-1 UI amplifier). |
| **C2-PR3 (fix, daemon)** | Cheap availability | (a) ollama `isAvailable` fetch gets `AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS)` (5s, same constant as peers); (b) copilot `isAvailable` drops only the 20s `validateCopilotToken` subprocess (moving it to explicit login/test flows) — the bounded `gh auth token` lookup (5s, `provider.ts:498-506`) must stay, since gh CLI installs that keep credentials in the OS keyring rather than `hosts.yml` are discoverable only that way; token presence (file/env/CLI) without subprocess validation becomes the availability signal. In the same PR, `getAuthStatus` must resolve credentials through the same discovery chain — today it checks only `storedCredentialToken` and the auth file (copilot `provider.ts:331-348`), so installs authenticated via `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`gh auth token` report the definitive "Not logged in" state while `isAvailable()` is true, and under C2-PR2(e)'s `errorKind` scheme that misclassified status would wrongly hide Copilot from the picker; the `ghp_` classic-PAT rejection stays definitive; (c) `providers.list`'s enrichment uses a bare `Promise.all` over `provider.isAvailable()` (provider-handlers.ts:187-201), so one rejecting provider — reachable for codex when `importFromCodexAuth`'s `saveCredentials()` throws (e.g. read-only auth dir) — fails the whole listing and defeats the page fix; catch per provider and return that record as unavailable, as `auth.providers` already does (auth-handlers.ts:93-101). Kills the 10s-timeout error class. |

**ADR classification:** the textbook **`requestRun`** candidate
(generation-guarded request/apply — "a stale response structurally cannot
apply"). C2-PR2 is its 2nd real use after `useFetchModels`; extract the
combinator on the 3rd (rule of three). No daemon pipeline needed.

---

## Area map (current dev)

| Sub-flow | Location | Owned state | Callers | Tests | Churn |
| --- | --- | --- | --- | --- | --- |
| Registry | D`lib/providers/registry.ts` (213 L) | in-memory provider Map | factory, sync, all RPC handlers | `provider-registry.test.ts` | stable |
| Factory / lifecycle | D`lib/providers/factory.ts` (312 L) | `disabledBuiltInProviderIds` (:26), `initialized` (:24), copilot import-promise cache (:282), custom-endpoint fingerprints (:285) | app.ts:358-396, provider-handlers | provider-handlers tests | low |
| Registry sync | D`lib/providers/provider-sync.ts` (163 L) | — (mutates registry) | app startup, providers.create/update | `provider-sync.test.ts` | low |
| Env/credential resolution | D`lib/provider-service.ts` (857 L, mostly env apply/restore :347-785); D`config.ts` + D`lib/credential-discovery.ts` (per-process env writes); credential store D`lib/credentials/*` | process.env, keychain `neokai.provider.<id>` | sessions (query spawn), RPC | `provider-service.test.ts` | medium (env paths touched by #2552) |
| Availability machinery | per-provider `isAvailable` (inventory in ACUTE 1); OAuth refresh scheduler D`lib/credentials/oauth-refresh-scheduler.ts` (5-min tick, 3-strike retry cap :66-90) | see ACUTE 1 inventory | providers.list/test/healthCheck, auth.providers, model-service | stranded probes covered (available/repeated/timed-out/concurrent + `providers.changed` recovery, `session-handlers.test.ts:278,322+`); scheduler covered (`oauth-refresh-scheduler.test.ts`); gaps: recovery-after-upstream-recovers transition and the copilot import-promise cache | low |
| Model listing (static) | GLM `glm-provider.ts:28-113` (7), Kimi `kimi-provider.ts:65-126` (4), DeepSeek `:29-56` (2), MiniMax `:28-73` (4, **absent from STATIC_MODEL_METADATA**), codex `codex-models.ts` (7), copilot static `provider.ts:56-134` (7), fallbacks in model-service `:29-63` | per-provider + global cache | pickers via `models.list` | per-provider pin tests exist | medium (GLM/Kimi lists updated regularly) |
| Model listing (dynamic today) | OpenRouter `/api/v1/models/user` (`openrouter-provider.ts:190-232`, allowlist `:164-188`, cap 30); Ollama `/api/tags` 5-min TTL (`ollama-provider.ts:143-167`); Copilot `client.listModels()` 5-min (`provider.ts:238-269`); **ACP fetcher** D`lib/acp/acp-model-fetcher.ts` + RPC `providers.fetchAcpModels` (provider-handlers.ts:211-232) — **no web caller yet**; custom endpoints `customEndpoints.listModels` + `normalizeModelList` (D`lib/rpc-handlers/custom-endpoint-handlers.ts:63-110,354-392`) | per-provider caches; **nothing persisted** | models.list, settings UIs | good coverage per provider | **high** — #2710/#2698 landed this week |
| Aggregation cache | D`lib/model-service.ts` (511 L): 4h TTL cache (:23-27), refresh/generation machinery (:106-343), static fallback (:65-71), alias resolution (`findInModels` :361-405) | global in-memory | `models.list` (session-handlers.ts:751-810), pickers, model-switch validation | `model-service.test.ts`, routing test | medium |
| Fallback chains | D`lib/agent/fallback-recovery.ts` (230 L, pure: chains, backoff ladder) + rate-limit watchdog D`lib/agent/rate-limit-watchdog.ts` (513 L) | per-message tried keys; cooldowns | agent-session, query-runner | strong | **high — #2661/#2664 in flight** |
| Concurrency limits | none at provider level (ADR Phase 2 explicitly open); session-level startup gate only (#2552) | — | — | — | — |
| Web provider page | W`components/settings/ProvidersSettings.tsx` (local state only, no store/signals), `AddProviderModal.tsx`, `useFetchModels.ts` | component state | RPC as mapped above | vitest suites | low |

---

## FEATURE CHAIN (C3) — Dynamic model discovery + per-provider curation

**Premise verified:** all hard-coded providers are Anthropic-compatible gateways
probed via `/v1/messages` only (D`lib/providers/shared/credential-probe.ts`);
they expose list-models endpoints. Five discovery implementations already exist
to generalize from, and #2710 just built the ACP one — **its RPC has no UI
caller yet**, so the chain completes a half-landed feature rather than starting
fresh.

Design (4 PRs):

1. **C3-PR1 — contract + RPC seam (daemon).** Generalize
   `providers.fetchAcpModels` into `providers.listRemoteModels {id,
   options?}`: the validated per-provider options field preserves the existing
   RPC's optional `command` override (provider-handlers.ts:211-232) so the
   curation editor can probe an edited command/baseUrl *before* persisting it;
   optional `listRemoteModels()` on the Provider contract; move
   `normalizeModelList` (handles `/v1/models` OpenAI+Anthropic and `/api/tags`
   Ollama shapes) from custom-endpoint-handlers to shared; implement for
   GLM/Kimi/DeepSeek/MiniMax (they share the `probeAnthropicCompatCredentials`
   shape, so a shared `fetchAnthropicCompatModels(baseUrl, apiKey)` helper
   covers all four). Routing acceptance is part of the contract: providers
   accepting discovery must resolve discovered IDs end-to-end — today DeepSeek
   silently substitutes `DEFAULT_MODEL` for unknown IDs in `buildSdkConfig`
   (deepseek-provider.ts:146) and Kimi maps unknowns to `kimi-for-coding`
   (kimi-provider.ts:377-414), so a discovered-but-unroutable ID would show in
   the picker while requests run the default — `ownsModel`/`buildSdkConfig`/
   `translateModelIdForSdk` must accept discovered IDs, or the merge must skip
   IDs the provider cannot route. Pin: ACP fetch behavior parity, including the
   command override.
2. **C3-PR2 — discovery cache (daemon).** Per-provider discovered-list cache
   (TTL 5 min, matching ollama/copilot) + explicit refresh RPC that writes it,
   **replaces the provider's slice in the global `modelsCache` before
   publishing — after applying the same curation filter as C3-PR4's merge**
   (an unfiltered splice with an existing curation would expose curated-out
   models until the next full rebuild) (the `updateAcpModelCache` pattern,
   acp/acp-query-runner.ts:1100-1119 — publishing alone is insufficient:
   `providers.changed` subscribers re-fetch a *cached* `models.list`, which
   returns the existing global cache, and stranded-provider detection will not
   refresh a provider that is already present), then publishes
   `providers.changed`; the write/slice-replace/persist path applies only to
   the **saved** configuration — probes invoked with `options` overrides
   (C3-PR1) are read-only, returning models to the caller without touching the
   provider cache, the global slice, or the persisted last-good list, which
   otherwise leaves trial-command/baseUrl models attached to the old config
   after an editor cancel; promote an override result into the caches only
   after the corresponding `providers.update` succeeds; `getModels()` merges
   discovered ⊕ static when
   discovery is enabled per provider. Persist the last-good discovered list in
   `providers.config_json` so restarts don't blank curated setups.
   **ADR shape:** fetch+cache = `requestRun`-shaped staged flow (snapshot →
   fetch → cache → notify; P8 with conditions trivially met — single idempotent
   write); the cache-merge decision itself = P1 transform.
3. **C3-PR3 — curation storage + UI.** Generalize the ACP precedent:
   `providers.config_json.models: [{id, name?}]` already parsed/applied
   (D`lib/providers/provider-sync.ts:61-66`, schema
   D`storage/schema/index.ts:299-316`) to every provider; per-provider
   "visible models" editor in the provider page (fetch remote → checkbox
   subset → save). Define empty ≠ absent explicitly: the ACP precedent maps
   `models: []` to the synthetic default (acp-provider.ts:164-167), so a fully
   deselected editor would re-show defaults — in the generalized curation,
   `[]` must mean "no visible models" (deliberately superseding ACP's legacy
   mapping, with a migration note for existing empty-`models` ACP configs),
   or the editor must prohibit saving an empty selection. Existing
   `config_json` writers must be converted to merge their provider-specific
   field into the stored object rather than replace it — the Kimi region
   editor currently writes `JSON.stringify({ region })` wholesale
   (W`components/settings/ProvidersSettings.tsx:204-210`), which would
   silently erase a saved curation/discovery list on every region change and
   defeat C3-PR2's restart persistence. OpenRouter's
   env-allowlist (`providerModelAllowlists`)
   migrates onto it later — don't remove in this chain.
4. **C3-PR4 — picker flow.** Curation applies inside the `model-service` merge
   (`mergeWithFallbackModels` seam, `:89-104`): a curated set filters
   static+discovered for that provider; the `getModelInfo` static fallback
   (`:435-436`) **and** `isValidModel`'s static/session-key fallback
   (`:456-487`) are also filtered — otherwise a curated-out model remains
   switchable, because `switchModel` checks `isValidModel` first
   (D`lib/agent/model-switch-handler.ts:129`) and a null `getModelInfo`
   (`:136`) leaves the submitted ID unchanged. Include a direct
   `session.model.switch` regression test for a curated-out model. Pickers
   need **zero changes** (they consume `models.list`). Pin: with curation set,
   `models.list` shows only the subset and switch rejects curated-out models;
   without, current behavior.

Sequencing: independent of C1/C2 except C3-PR4's merge seam, which should land
after C1-PR2 (same function neighborhood).

---

## Collision check — PRs #2661 / #2664

Both open, targeting `dev`, confined to `packages/daemon/src/lib/agent/` +
`acp/acp-query-runner.ts` + tests (limit-error pipeline; #2664 adds the LLM
tier, stacked on #2661's files). **Zero file overlap** with anything in
C1/C2/C3 (providers/, model-service, provider-handlers, web). Only interaction:
the ADR Phase 2 provider-concurrency admission gate (C5 below) should *consume*
the `limit-error-classifier` API those PRs introduce — sequence C5 strictly
behind their merge. No rebase risk for the acute chains.

## Ranked chains (all)

1. **C1 — stuck-provider recovery** (acute; 3 PRs above). Highest user pain;
   PR1+PR2 are small and independent.
2. **C2 — provider-page refresh** (acute; 3 PRs above). PR2 is the
   `requestRun` second-use; PR3 protects every provider-page action.
3. **C3 — discovery + curation** (feature; 4 PRs above). Completes #2710's
   missing half.
4. **C4 — availability hygiene sweep (small, optional):** make
   `providers.list`/`auth.providers` never do unbounded network work (fold of
   C2-PR3 — custom endpoints need nothing here: their `isAvailable` is
   `Boolean(config.baseUrl)` and their probe, already timeout-bounded, runs
   only in explicit test/`getModels` paths,
   D`lib/providers/custom-endpoint-provider.ts:132-134,143-176`); consider
   persisting `OAuthRefreshScheduler` retry state across restarts — but only
   with a re-arm condition: persisting the current retry-count map as-is would
   also persist its terminal state (after 3 strikes `refreshProviderIfNeeded`
   returns before retrying, oauth-refresh-scheduler.ts:66-90), turning a
   process-lifetime outage into one that survives restarts; persist timestamps
   with decay/backoff rather than raw counts. Only if C2-PR3 leaves gaps.
5. **C5 — provider-concurrency admission gate (structural, ADR Roadmap Phase
   2):** `decisionRun` admission in the message pipeline that queues a message
   *before* session persistence when its provider is at its concurrency limit;
   consumes #2661's classifier + the existing backoff ladder
   (fallback-recovery.ts). Sequence behind #2661/#2664 merge. Scope note only —
   needs its own design pass.

## Do-not-extract zones (pipelines/refactors)

- **Bridge servers** — `openai-responses-bridge/server.ts` (1,758 L),
  `openai-chat-bridge/server.ts` (845), `anthropic-copilot/server.ts` (579),
  `ollama-bridge-server.ts` (490), `anthropic-messages-bridge/server.ts` (277):
  streaming-translation hot paths with stateful sockets; not decision cores;
  churn is low and parity risk is extreme.
- **`provider-service.ts` env apply/restore block (:347-785):** key-by-key
  `process.env` mutation with user-snapshot preservation — process-global side
  effects a pipeline must not own (ADR resource-ownership rule).
- **`inferProviderForModel` (registry.ts:152-192) + its web twin
  (`useModelSwitcher.ts:128-158`):** sub-µs if-cascade on a hot routing path
  (ADR hot-path rule); also duplicated web/daemon deliberately.
- **`withProviderLock` mutation queue (provider-handlers.ts:138-144):**
  ordering/atomicity shell, not a decision.
- **OAuth device-flow/background polling loops** (copilot
  `provider.ts:587-672`, codex `:673-762`): long-running stateful loops —
  "never the loop".

## Additional bugs/races noticed (report only, no fixes proposed)

1. **Disabling copilot deletes its OAuth credentials**:
   `removeProviderFromRegistry` calls `provider.logout()`
   (provider-sync.ts:145-151), which removes `github-copilot` from `auth.json`
   (copilot `provider.ts:400-415`). Re-enable recovers only because the
   credential manager kept a copy.
2. **Copilot import-promise stuck-null:** one failed dynamic import caches
   `null` forever (factory.ts:217-222, :282-283); enable/disable reuses it —
   provider gone for the process lifetime with no recovery. (Doesn't match the
   toggle-fixes-it symptom, hence report-only.)
3. `registry.getProviderInfo()` uses bare `Promise.all` over
   `isAvailable()+getModels()` (registry.ts:61-80) — one throwing provider
   rejects the whole listing. Currently no production callers (only
   `ProviderService.getAvailableProviders`, itself uncalled) — a landmine to
   delete or fix when touched.
4. `OAuthRefreshScheduler` abandons a token permanently after 3 failed
   refreshes (oauth-refresh-scheduler.ts:66-90) — no re-arm after backoff;
   marks provider unhealthy (display-only) forever.
5. `providers.delete` on built-ins sets `isEnabled=false` and keeps the row
   (provider-handlers.ts:391-392) — "deleted" providers reappear as disabled;
   deliberate?
6. `ModelsSettings.fetchModels` returns silently when the hub is missing
   (ModelsSettings.tsx:467-468) — empty list, no error, no retry.
7. Kimi region merge keeps stale entries for deleted rows
   (`{...nextRegions, ...prev}` — ProvidersSettings.tsx:96).
8. `triggerBackgroundRefresh` lacks `refreshModels`' shrink-guard
   (model-service.ts:148-155 vs :320-324) — inconsistent: the background path
   can silently drop providers the foreground path preserves. Deliberate-unify
   when C1-PR3 touches this file.
9. `getModelsCache`/`setModelsCache` (model-service.ts:345-359, `@public` test
   helpers) are used by production ACP code to splice models into the global
   cache (D`lib/acp/acp-query-runner.ts:1089-1121`) — a fragile seam C3 should
   formalize.
10. DB `healthStatus` is written by test/healthCheck but never gates anything
    (display-only dot, W ProvidersSettings.tsx:442) — the health machinery is
    cosmetic; all real gating is in-memory (relevant when designing C4/C5).
11. The `anthropic-codex` bridge starts servers with empty auth when
    credentials are missing (codex provider `:539-546`) — requests fail later
    at the bridge rather than at admission; related to C5.
