# UI Pilot 6 closing report — live-query lifecycle drift, store variants, unification proposals

2026-08-23. Closing deliverable of UI Pilot 6 (web live-query lifecycle onto a pure
machine, ADR 0004). Chain: #2714 (superpipe dependency), #2716 (characterization
pins for `useSpaceTaskMessages`), #2718 (`live-query-lifecycle` machine), #2724
(`useSpaceTaskMessages` facade), #2756 (`useActorMessageProjections` +
`useTaskMilestones` facades), #2788 (`useGroupMessages` facade), plus this PR.

Everything in "Proposed unification PRs" is **proposed only — none is applied
here**. Each changes pinned observable behavior; the owner decides which, if any,
to take. This PR applies only the dead-code sweep result (last section).

## Method

Read the four migrated hooks side by side against
`packages/web/src/lib/live-query-lifecycle.ts` (the machine) and its contract
suite, diffed each hook against its pre-migration body, and re-verified every
claimed behavior in the current source (line references below are current).
PR-4 (#2756) and PR-5 (#2788) recorded per-PR drift tables; those are folded in
and reconciled here rather than re-derived.

## The machine and its config surface

`createLiveQueryLifecycleState(config)` accepts three knobs; everything else is
structural:

| Knob | Default | Meaning |
| --- | --- | --- |
| `snapshotRetryEnabled` | `true` | Arm the await-snapshot watchdog after `subscribed`. `false` = wait forever for the first snapshot. |
| `snapshotRetryDelayMs` | `2000` | Fixed (non-escalating) delay for each watchdog re-arm. |
| `maxSnapshotRetries` | `5` | Watchdog budget; exhaustion settles `settled-empty` (loading released, error stays `null`). |

The machine has **no subscribe-request-failure event** — a rejected
`liveQuery.subscribe` RPC reaches it only as a messageless `snapshot-failed`.
Retry-on-rejected-subscribe therefore always lives in the executor (only
`useGroupMessages` has one). The machine's stale-event guard is the generation
counter; `disposed` is terminal (a store adapter must create a fresh machine per
subscribe, it cannot revive one).

## Consolidated drift table

STM = `useSpaceTaskMessages` (#2724), PRJ = `useActorMessageProjections` (#2756),
MIL = `useTaskMilestones` (#2756), GRP = `useGroupMessages` (#2788).

| # | Dimension | STM | PRJ | MIL | GRP |
| --- | --- | --- | --- | --- | --- |
| 1 | Machine config | defaults (watchdog on) | `snapshotRetryEnabled: false` | `snapshotRetryEnabled: false` | `snapshotRetryEnabled: false` |
| 2 | Snapshot watchdog | on: re-arms every 2s, settles empty after 5 (~10s) | none — first snapshot never arriving leaves `isLoading` claimed forever | none — same | none — same |
| 3 | Retry cadence | fixed 2s, budget 5, reset on transport-error (all machine-side) | n/a | n/a | n/a |
| 4 | Rejected `subscribe` request | 1 attempt → messageless `snapshot-failed` → settle empty, late snapshot revives | same | same | executor ladder: 2 retries at 500ms/1500ms, then settle empty; late snapshot revives |
| 5 | `liveQuery.error`, snapshot phase | machine settles with `error` emission; surfaced as `error` in result | settles with error emission; **error payload discarded** (no `error` in result), only loading released | **no error listener at all** — error ignored, loading can stay claimed | settles with error emission; payload discarded |
| 6 | `liveQuery.error`, delta phase | `transport-error` → same-subscriptionId resubscribe (generation bump) | same | not wired (stream loss does not resubscribe) | same as STM |
| 7 | Error surfaced to UI | yes (`lifecycle.error` mirrored; exhausted-watchdog settle keeps it `null`) | no | no | no |
| 8 | Reconnect mechanism | `onConnection('connected')` → `transport-error` **and** `isConnected` effect rerun — both fire per reconnect | same double path, `onConnection` half guarded by `activeSubIdRef` | same as PRJ | **no `onConnection`** — reconnect rides the `isConnected` dep alone: full teardown, fresh subscriptionId, fresh machine (pinned, #2788) |
| 9 | Stale-closure guards | generation guard only (effect teardown unsubscribes listeners) | generation + `activeSubIdRef` | generation + `activeSubIdRef` | generation + `activeSubIdRef` (also guards the ladder timers) |
| 10 | Pre-snapshot / mid-resubscribe deltas | dropped unless `live` (machine gating; end state restored by the resubscribe snapshot) | same (PR-4 drift rows 7–8) | same | same (PR-5 "window tightening") |
| 11 | `settled-empty` | releases loading, no error | releases loading | releases loading | releases loading |
| 12 | Secondary subscription | `spaceTaskActiveTurn.byTask` side channel, fully hand-rolled beside the machine (own error/reconnect paths, rows cleared on failure) | none | none | none |
| 13 | Row store | two `useState` row arrays | `useState` | `useState` | `useReducer` pagination (cutoff/hidden counts) — the adjacent machinery the pilot deliberately did not touch |

Rows 4–8 are the behavior-relevant drift; rows 2/3/11 are pure config; rows 9–13
are structural. All 13 are pinned: machine contract suite
(`live-query-lifecycle.test.ts`, 22 tests incl. the full status×event table) plus
four `.lifecycle.test.ts` characterization files (584/352/272/414 lines) written
green against the pre-migration hooks and unchanged since.

## PR-5 store-variant assessment (consolidated)

From #2788, including its round-1 review correction, plus this PR's inventory of
the three variants that review flagged as un-assessed. Production
`liveQuery.subscribe` sites in web are exactly the four hooks above and six
stores: `app-mcp-store`, `global-store`, `session-store`, `skills-store`,
`space-mcp-store`, `space-store`.

| Store | Verdict | Notes |
| --- | --- | --- |
| `app-mcp-store` | **Fits as-is** | Single fixed subscription, imperative `subscribe()`/`unsubscribe()`, snapshot/delta/error listeners, `onConnection` resubscribe, real error+loading signals. Maps 1:1 with `snapshotRetryEnabled: false`; settle-with-error ≈ its `error.value` + `loading=false`. Best first store consumer. |
| `global-store` | Fits with one small machine extension — or legitimately stays hand-rolled | `sessions.list` has dynamic params (`showArchived` toggles re-subscribe under a stable id); the machine has no params-changed event. Also swallows all errors and has no loading surface, so `error-retry`/`settled-empty` carry no UI meaning. |
| `space-store` | Fits with machine extensions + a store adapter; highest payoff | Four near-identical blocks (`spaceTaskActivity.byTask`, `spaceTaskMessages.byTask.compact`, `nodeExecutions.byRun`, `spaceSessions.bySpace`). Caveats: no `liveQuery.error` listeners anywhere (migration would *add* an error path needing a policy decision); `subscribeTaskActivity`/`subscribeTaskMessageActivity` are awaited and throw on initial failure (needs an async bridge — the machine settles via emissions); reconnect resubscribe is fire-and-forget with no retry/settle. **Correction from #2788 review:** `nodeExecutions.byRun` is single-active in practice — `ensureNodeExecutions` unsubscribes every run subscription before subscribing to a new run — so one machine instance at a time suffices; the N-concurrent concern was overstated. |
| `space-mcp-store` (inventoried here) | Fits, same caveats as `app-mcp-store` | Singleton `mcpEnablement.bySpace` subscription with snapshot/delta listeners, `onConnection` resubscribe, awaited subscribe that throws to the caller, loading+error signals, no `liveQuery.error` listener. Needs the async bridge and a fresh-machine-per-`subscribe()` adapter (`disposed` is terminal). |
| `skills-store` (inventoried here) | Fits, same shape as `space-mcp-store` | Same subscribe/unsubscribe skeleton with snapshot/delta listeners and `onConnection` resubscribe. |
| `session-store` `messages.bySession` (inventoried here) | **Does not fit today** | The subscription is wrapped in a recovery protocol: `MESSAGE_TOO_LARGE` handling, a hand-rolled `awaitingSnapshot` delta gate (its own version of the machine's `live` gating), `beginRecovery`/`performRecovery` on disconnect/reconnect, and optimistic-message preservation in the apply path (`mergeSnapshotIntoTranscript`'s prefix preservation plus uuid-keyed dedup in `mergeSdkMessagesWithDedup`). All of it lives above the subscription lifecycle; candidate only after recovery orchestration is itself extracted. |

## Proposed unification PRs — NOT applied, owner decides

Ordered by value/risk ratio. U1+U5 pair naturally; U3 subsumes the mechanical
parts of all others and is the gateway to the `reduceRun` combinator (ADR 0004
rule-of-three; see the ADR 0004 pilot note added by this PR).

### U1. Enable the snapshot watchdog everywhere (kill rows 2/3 drift)

Flip PRJ/MIL/GRP to default config (drop `snapshotRetryEnabled: false`).
- **Value:** a dead/hung query stops claiming `isLoading` forever; all four
  copies get the same bounded wait (~10s) and settle-empty recovery; rows 2 and
  3 collapse (row 4 needs U3 — the machine has no request-failure event either
  way).
- **Risk:** observable behavior change on three surfaces — up to 5 extra
  subscribe/snapshot exchanges per dead query (daemon-side load if a query name
  is misconfigured), and "loading forever" becomes "empty after ~10s", a product
  call for MIL/GRP panels. Pins that must move: PR-4 rows 1–2 pins (no-watchdog,
  messageless-settle), PR-5's no-watchdog and ladder-settle pins. GRP's ladder is
  unaffected: it retries only *rejected* subscribe requests while the machine
  sits in `subscribing`, whereas the watchdog arms only after `subscribed`
  dispatches — disjoint phases, no precedence decision, so U1 stands alone for
  GRP without U3.

### U2. One reconnect mechanism (kill row 8 drift)

Standardize on the `isConnected` rerun (GRP's path): drop the `onConnection`
half from STM/PRJ/MIL.
- **Value:** one reconnect story (fresh subscriptionId + fresh machine, server
  re-pushes the snapshot); removes the double-path churn (each reconnect
  currently costs a same-id resubscribe *and* a full teardown) and three
  divergent `activeSubIdRef` guards.
- **Risk:** same-id resubscribe (transport-error) is cheaper than full teardown
  when the socket survives — standardizing on rerun trades a rare wasted
  subscribe for simplicity; STM's active-turn side channel is currently
  re-established by both paths, so the rerun-only path must keep covering it (it
  does — the effect re-runs both subscriptions). Pins that must move: the
  reconnect pins in all three `.lifecycle.test.ts` files.

### U3. Shared executor for the four facades (the `reduceRun` precursor)

Extract the dispatch/`executeEffects`/timer scaffolding (≈30–40 lines per hook,
structurally identical) into one executor; per-hook config becomes declarative
(query name/params, emission mapping, row store, retry ladder on/off).
- **Value:** rows 4, 9, and 11 become config; the drift table shrinks to rows
  5–8 (policy) + 12–13 (surface); the executor is exactly the body a future
  `reduceRun` combinator would own, so this is the promotion path ADR 0004
  already sanctions at ≥3 uses (4 exist).
- **Risk:** medium mechanical risk concentrated in emission mapping — STM
  surfaces `error` and runs the active-turn side channel, GRP feeds a pagination
  reducer; the four pin files must pass byte-for-byte unchanged except where U1/U2
  already moved them. Landing U3 before U1/U2 freezes current drift as config;
  landing it after shrinks what U1/U2 touch. Either order works; after is smaller.

### U4. Adopt the machine in `app-mcp-store` (+ `space-mcp-store`, `skills-store`)

First store consumers; fresh machine per `subscribe()` call, async bridge for
awaited-and-throwing subscribes, `snapshotRetryEnabled: false`.
- **Value:** three more copies of the same skeleton collapse; proves the
  non-hook adapter shape (singleton stores, imperative lifecycle) that
  `space-store` (highest payoff, four blocks) then reuses.
- **Risk:** stores surface subscribe failures by throwing — the machine settles
  via emissions, so the bridge must reject the `subscribe()` promise on an
  `error`/`settled-empty` emission (a policy choice: settle-empty currently
  means "release loading, no error"). The three singleton stores already carry
  direct lifecycle pins (`lib/__tests__/app-mcp-store.test.ts`,
  `lib/__tests__/space-mcp-store.test.ts`, `lib/skills-store.test.ts` — subscribe
  failures, loading/snapshot, deltas, stale events, reconnect, unsubscribe): the
  migration must keep those suites green as the pins and add only genuinely
  missing cases (e.g. snapshot-error settle), not re-pin from scratch.
  `space-store`/`global-store`/`session-store` are where the pin gap actually
  sits.

### U5. Wire MIL's `liveQuery.error` listener (kill row 5/6 gap)

Map delta-phase → `transport-error`, snapshot-phase → `snapshot-failed`, matching
PRJ.
- **Value:** milestones resubscribe on stream loss like every other surface;
  smallest standalone behavior fix in the set.
- **Risk:** pure behavior addition (more resubscribes); needs a pin for the
  previously-invisible error path and a decision on whether MIL starts surfacing
  an error (today it has no error field — pairing with U3's emission mapping
  avoids inventing one).

### U6. Retire the `'full'` query variant of `useSpaceTaskMessages` (web-side)

Found by this PR's dead-code sweep: no production caller passes `'full'`
(`SpaceTaskUnifiedThread` passes `'compact'`, `TaskArtifactsPanel` uses the
default); nothing else in web constructs `spaceTaskMessages.byTask`.
- **Value:** removes a dead parameter + type from a migrated hook.
- **Risk:** none in web beyond one test that exercises `'full'`
  (`useSpaceTaskMessages.test.ts`); the daemon still registers and benchmarks
  `spaceTaskMessages.byTask` as a named query — retiring that registration is a
  daemon-side decision (other RPC clients could subscribe by name) and is
  explicitly out of scope here.

## Dead-code sweep result (applied in this PR)

The migration PRs left nothing behind — verified by diffing each hook against
its pre-migration body: STM's inline watchdog (`SNAPSHOT_RETRY_DELAY_MS`,
`MAX_SNAPSHOT_RETRIES`, `sawSnapshot`, `snapshotRetries`, `subscribeGeneration`),
GRP's `subscribeWithRetry`/`MAX_RETRIES` closure, and the old listener bodies are
all gone. knip (files/dependencies/exports), oxlint, and `tsc --noEmit` are clean
on web.

One find, applied: the **web `superpipe` dependency** (added by #2714 "for UI
Pilot 6 functional cores") is unused — the machine stayed a plain reducer under
ADR 0004's earn-the-layer rule (no web source imports it; only daemon modules
do, and daemon declares its own). This PR removes the dependency and its knip
`ignoreDependencies` entry; re-add both when a superpipe-based `reduceRun`
combinator actually lands in web.

Recorded, not removed: `LiveQueryEmission` and `LiveQueryLifecycleTransition` are
exported types with no external importer — kept as the machine's documented
contract surface (zero runtime cost; knip's `ignoreExportsUsedInFile` setting
deliberately tolerates this class). U6 above is the other recorded find.
