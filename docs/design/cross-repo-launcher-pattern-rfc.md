# RFC: Cross-Repo Launcher Pattern (Orchestrator Agent + Per-Repo Goals)

Status: Proposed — **decision recorded: prompt-only** (ratified on merge; §7).
Date: 2026-08-25. Tracks issue #2538 (WS 20/20, terminal slice of the multi-workspace
epic spanning #2519–#2536). Companion usage doc: #2537 lands the `docs/features/`
multi-workspace page; this RFC owns the orchestration pattern only.

## 1. Problem

The multi-workspace epic lets one Space register several repositories and binds every
task and goal to exactly one of them. Two invariants follow (#2537):

- **One task, one repo / one session, one repo.** A task's worktree is created inside
  its bound repo; a workflow run still freezes a single PR (#2537 lists this as a kept
  limitation).
- **A repo belongs to exactly one Space.** Path registration is unique across spaces —
  an epic invariant (#2537) enforced through #2522's cross-space path lookup.

So no single task can ever coordinate two repos. Path uniqueness also does **not**
imply that two repos share a Space — repo A in Space X and repo B in Space Y satisfies
the invariant — but every goal/task tool an orchestrator has is scoped to its own Space,
and the message resolver hard-rejects cross-Space targets. This RFC therefore takes a
**prerequisite** rather than inferring one: the pattern covers objectives whose repos
are all registered in the **same** Space (the scenario in §2 registers both). Objectives
spanning two Spaces are explicitly unsupported for v1 (§7). Within one Space, what is
missing is the layer *above* tasks: an agent that owns two repo-bound goals and moves
them toward one objective, deciding when progress on one goal releases, withholds, or
rewrites work on the other. This RFC names that pattern, binds it to the primitives the
epic ships, and decides whether anything new must be built.

## 2. Real usage scenario

**Ship `messages.search` end to end.** A Space "platform" registers two workspaces:

- **Repo A** — the HyperNeo monorepo. Goal A: *land the conversation-search RPC plus the
  FTS migration and release the daemon* (`feat(daemon): messages.search RPC`).
- **Repo B** — a downstream TypeScript SDK repo. Goal B: *ship `client.messages.search()`
  with typed request/response helpers, runnable examples, and a `2.4.0` release*.

The couplings that force orchestration rather than two independent goals:

1. **Hard gate.** B's release task cannot start meaningfully before A's migration + RPC
   merge; releasing against a speculative contract produces a broken SDK version.
2. **Soft, bidirectional gate.** A's request/response field naming should be reviewed for
   SDK ergonomics *before* A merges — B's owner reacts to A's in-flight task, not only to
   its terminal outcome.
3. **Slip propagation.** If A's merge slips past B's release date, B must pause rather
   than publish stale typings.
4. **Drift correction.** If a follow-up change in A alters the contract after B's task
   started, B's in-flight work must be corrected, not discovered broken at B's CI.

The same shape covers an app repo + docs-site pair (docs publish gates on the app
release; screenshots must show the shipped UI) and a monorepo + deployment-config pair.
All variants share the skeleton: per-repo goals, one hard gate at an artifact boundary,
soft gates around contract quality, and correction on drift.

## 3. Verified substrate

Everything below exists on `dev` or is an approved in-flight epic slice. The pattern in
§4–§6 is assembled from these pieces; nothing else is assumed.

**Workspace binding (epic).**

| Primitive | Status |
| --- | --- |
| `space_workspaces` registry, `UNIQUE(space_id, path)`, one primary per Space | landed, migration 217 (#2521) |
| `SpaceWorkspaceRepository` CRUD + cross-space path lookup | in flight (#2522) |
| `space_goals.workspacePath` pinning | landed, migration 218 (#2535 17a) |
| `space_tasks.workspace_path` + shared types | landed, migration 219 (#2527) |
| Goal-pinned tasks inherit the goal's workspace; central `resolveTaskWorkspace()`; `createTaskWorktree(repoRoot)`; task RPC/tool `workspacePath` params | in flight (#2528–#2531, #2535 rest) |

**Goal machinery (shipped).**

- The goal model carries `workspacePath` (migration 218) and `primaryOwnerAgentId`, plus
  rolling `summary`, `metrics`, `progress`, `nextSteps`, `activeTaskId`/`lastTaskId`, a
  check-in cadence held on a linked `TaskSchedule` (created from
  `checkInCronExpression`/`checkInTimezone`), and a monotonic `revision`. (The service
  layer accepts these fields; exposing `workspacePath` on the MCP tool schemas arrives
  with #2531/#2535 — spawn paths today still resolve from the Space primary.)
- `trigger_goal_task` creates a goal-linked task immediately, or queues **one** follow-up
  when a goal task is already active and `autoTriggerNext` is set — per-goal execution is
  serial by construction.
- Goal-linked task terminal outcomes produce durable outcome notifications in the same
  transaction as the terminal write; they wake the **primary owner** (or the coordinator
  fallback when no usable owner exists — `goals/goal-owner-resolution.ts`), are recovered
  at startup (`SpaceRuntimeService.recoverPendingOutcomeNotifications`), and are disposed
  through `review_goal_outcome`: identity-bound claim, revision CAS, acknowledge/reject/
  supersede dispositions, idempotent retries.
- The inactivity nag (`deliverLongHorizonAgentNag`) re-prompts an owner sitting on pending
  notifications; `review_goal_outcome` with no arguments discovers claimable notifications.
- `create_standalone_task` supports `depends_on` (same-Space task IDs; blocked until every
  dependency is `done`, cascade-cancelled, cycles rejected).
- `pause_goal` / `resume_goal`, `retry_task` / `reassign_task`, `interrupt_session`, and
  `send_message_to_task` are owner-reachable tools.

**Long-horizon (LH) agents (shipped).**

- LH agents are durable Space actors with their own persistent session, created in the
  Space **primary** workspace with `worktreeMode: 'direct'`
  (`space-runtime-service.ts`, `ensureLongHorizonAgentSession`) — an LH agent is not
  itself inside either repo's worktree.
- Their sessions get the `space-agent-tools` MCP (86 tools: sessions, tasks, goals, forge,
  schedules, agent admin), `agent-memory`, and `db-query`; prompts append
  `LONG_HORIZON_OWNER_REVIEW_CONTRACT` and `LONG_HORIZON_SCHEDULING_GUARDRAIL`
  (`packages/prompts/src/agents/`).
- The owner-review contract already defines the single-owner loop: create goals, delegate
  via `trigger_goal_task`, review outcomes via `review_goal_outcome`, create follow-ups.
  Workers report outcomes in tasks; only the owner mutates goal rolling state.
- Durable reminders (`create_agent_reminder`) and external-event subscriptions
  (`subscribe_agent_event`) exist; goal check-ins create ordinary Space tasks.

**Messaging (shipped).**

- `send_message` is a **workflow-node-agent** tool (node-agent MCP), scoped by the run's
  channel topology. LH agents do not have it.
- LH agents reach running task members with `send_message_to_task` and any Space session
  with `send_session_message` (autonomy-gated).

## 4. The launcher pattern

A **launcher** is an ordinary LH agent that owns ≥2 goals pinned to distinct registered
workspaces plus a doctrine for sequencing them. No new runtime concept is introduced.

**Role.**

- The launcher's own session stays in the Space primary workspace. It never edits either
  repo directly; every repo mutation flows through a task bound to that repo — normally
  goal-linked, except the hard-gated artifact steps §5 carves out as standalone gated
  tasks. This respects one-task-one-repo and one-session-one-repo, keeps each repo's PR frozen
  per run, and keeps the orchestrator's deliverable — goal state and gated sequencing —
  out of the repos it coordinates.
- One launcher owns the whole objective. Workers stay single-goal and single-repo; they
  report outcomes in their tasks and do not see the other goal (per the existing
  owner-review contract division).

**Prompt surface (the only artifact this decision produces).**

The doctrine is prompt content, deliverable two ways:

- **Zero-code:** any LH agent can carry the doctrine in its `instructions`
  (`create_agent` / `update_agent`) — `buildLongHorizonAgentSessionConfig` already
  appends agent instructions to every LH session prompt. This is usable only once the
  workspace parameters ship (#2531/#2535): today's creation tools cannot pin a goal or
  task to repo B, so until then the pattern needs goals provisioned by a surface that
  can, or it degrades to launching B's work in the Space primary.
- **Packaged:** a long-horizon template family file (e.g. `cross-repo-launcher.md`,
  alongside `release-manager.md` and peers) registered in the daemon's
  `LONG_HORIZON_AGENT_TEMPLATES` array, with the whole contract embedded in the
  template's `instructions` (`create_agent_from_template` copies them verbatim).
  Deliberately **not** a new append in `buildLongHorizonAgentSessionConfig`: that
  builder is shared by every LH agent with no template-family branch, so a global
  `CROSS_REPO_LAUNCHER_CONTRACT` append would teach coordinators, release managers, and
  auditors the multi-goal launcher doctrine. This is mechanical registration of existing
  prompt machinery, not new runtime behavior (§7).

The launcher contract extends the owner-review contract with:

- **Declare the contract between goals** in each goal's `nextSteps`: what each goal is
  waiting on, in terms the other goal's task outcomes can satisfy ("B 2.4.0 waits on A
  task #N done: RPC + migration merged; field names frozen as listed").
- **The launcher is the sole trigger authority.** Pattern goals run with `autoTriggerNext`
  disabled: a queued successor is auto-created *and claimed* inside the terminal
  transaction — before the launcher reviews the outcome — so the goal's pointer is
  already occupied with stale-`nextSteps` work when the launcher wakes. If a goal is
  found with a queued successor active on wake, reconcile it through the drift sequence
  (pause → cancel) before re-triggering.
- **Choose the gate mechanism per coupling** using the taxonomy in §5 — hard artifact
  gates become gated tasks (`depends_on`); judgment gates `pause_goal` the dependent
  goal for the gate's duration with the condition recorded in `nextSteps`.
- **Keep one leading goal.** At least one goal always has an active or triggerable task;
  if every goal is waiting on another, pause the dependent goals and escalate (§6).
- **Correct on drift.** When a gating goal's later outcome invalidates dependent work:
  **validate the decision first** — re-read A (`get_goal`) and acknowledge A's
  notification **with** a small goal-state update (a bare acknowledge skips the revision
  gate — `applyRevisionMatchGate` only checks when an update is present — and pausing B
  before this check would leave an unjustified cross-goal mutation with no rollback if
  the review returns `stale_revision`). Then ensure B is paused — an existing paused
  state satisfies this (the hard-gate doctrine leaves B paused while its gated task
  runs, and `pauseGoal` rejects non-active goals); when the pause is fresh, it also
  prevents a cancel while B is active with `autoTriggerNext` set from making the
  terminal transaction create the queued stale successor immediately. Then cancel
  **everything of B's that is running the stale contract** — the active goal task *and*
  the tracked gated task, each with `cancel_workflow_run: true` when workflow-backed
  (a bare `cancel_task` terminalizes the task record but leaves the run's agents
  executing; the gated shapes never appear in `activeTaskId`, so cancelling only the
  goal task misses them). Dispose **all** resulting pending notifications — the
  cancellations' (goal-linked tasks that had started yield one each) — then record the
  fresh contract in B's `nextSteps`, then release — **only if this sequence introduced
  the pause**: if B was already paused for another gate or a human hold, keep it paused
  and record the drift outcome against that hold's `nextSteps` instead of releasing it.
  When releasing: clear any retained cadence **while B is still paused**, then
  `resume_goal` and `trigger_goal_task` (resuming first reactivates the schedule, and a
  fire in the interval can claim B's task before the launcher's own trigger).
  (`interrupt_session` alone only stops the current turn; the task stays active and a
  subsequent `trigger_goal_task` would throw or merely queue.)
- **No tight loops.** Cross-goal re-evaluation rides the launcher's own reminders and
  the gating goal's wakes/check-ins — the scheduling guardrail's durable-vs-transient
  rule already forbids in-turn polling for durable concerns.

**Tool surface.** Unchanged: the existing 86 `space-agent-tools`. The loop concretely
uses `create_goal`, `trigger_goal_task`, `review_goal_outcome`, `update_goal`,
`pause_goal`/`resume_goal`, `list_goal_tasks`/`get_task_detail`/`list_tasks`,
`create_standalone_task` (`depends_on`), `cancel_task` (`cancel_workflow_run: true` for
workflow-backed tasks), `send_message_to_task`, `create_agent_reminder`,
`subscribe_agent_event` — with `workspacePath` parameters on task/goal creation tools
arriving with #2531/#2535.

## 5. Synchronization points: goal tools vs `send_message`

**Decision: synchronize on the goal plane only.** The outcome-notification loop *is* the
sync point. A's goal-linked task reaching a reportable terminal state wakes the launcher;
`review_goal_outcome` is where the sync decision is made and recorded — durable,
identity-bound, revision-CAS'd, restart-safe, and auditable in `space_goal_events`.
`update_goal`/`nextSteps` on the dependent goal is the record of "what B is waiting on".

`send_message` is rejected as a sync mechanism for v1:

- It is worker-plane plumbing scoped to a workflow run's channel topology; LH agents do
  not have it, and extending it to LH agents would add an ephemeral, unaudited channel
  beside the durable one. Sync decisions that live only in messages are lost to the next
  wake and invisible in goal history. Message-plane loops are also actively discouraged
  by the runtime: pending node-agent deliveries carry a 60 s TTL / 3 attempts, and cyclic
  channel ping-pong trips a dead-loop guard (15 round-trips per 5 minutes).
- The message resolver hard-rejects any cross-Space target, confirming that multi-repo
  sync is single-Space messaging at most.
- The one legitimate pre-terminal need in the scenario — steering A's task on SDK
  ergonomics before it merges — is already served by `send_message_to_task`, which
  reaches a running task's members (and queues for inactive ones) without new topology.

**Gating taxonomy.**

| Coupling | Mechanism | Enforced by |
| --- | --- | --- |
| Hard artifact gate (B's task cannot start without A's artifact) | Gated task with `depends_on` (standalone, or atomic via a Forge proposal — shapes below), **and** before either gated shape is created: goal B confirmed paused **and** any already-active dependency-sensitive B task checked for and cancelled with its run — a check-in firing in the create interval claims B's empty active-task pointer, and the later pause suspends only future fires without stopping the task already created — **and** any notification that cancellation produces disposed first (a started task yields one; a pre-start cancellation yields none) | Runtime: blocked until the dependency is exactly `done` (`approved`/`review` do not release it); a cancelled dependency cascade-cancels dependents; a failed one blocks **running** dependents with `dependency_failed`, while a pre-start dependent merely stays `open` but unschedulable (§5 rebinding covers it). The pause is required doctrine: gated shapes never claim B's active-task pointer, so a B check-in fire could otherwise spawn a separate ungated goal task and perform the release the gate exists to prevent. The launcher resumes B **only when the gated step completes successfully** — a `blocked`/`cancelled` gated step keeps B paused for retry or escalation — and for the **Forge** shape only after that outcome is reviewed (the notification records at the paused goal's revision, and a `resume_goal` in between bumps the revision so the review fails `stale_revision`); only the standalone shape (no goal outcome) may resume immediately after terminal inspection. For a retained-cadence B, the cadence additionally stays cleared until that task's outcome is reviewed, not merely until the pointer is claimed — restoring earlier reactivates the schedule while the gated shape leaves `activeTaskId` empty, letting a scheduled fire claim the pointer and run a second B task concurrently |
| Judgment gate (partial completion quality must be reviewed) | Launcher `pause_goal`s B for the duration of the gate with the condition recorded in B's `nextSteps`; on release — clear any retained cadence **while still paused**, then `resume_goal` + `trigger_goal_task` | Prompt doctrine. A withheld `trigger_goal_task` alone does **not** hold: with a check-in schedule configured, the scheduled fire creates a goal task and claims B's empty active-task pointer without consulting `nextSteps` — pausing suspends that schedule too |
| Durable wait (A slipped/blocked indefinitely) | `pause_goal` on B with the wait recorded — and if B already has an active dependency-sensitive task, pause first, then cancel that task (`cancel_workflow_run: true` where applicable) and dispose the resulting outcome: pausing alone leaves the task and its run executing through publication; `resume_goal` when released | Prompt doctrine; visible in goal state/UI |
| Milestone release (partial completion of A releases B) | Milestones listed in A's `nextSteps`/`metrics`; B's gate names the milestone; launcher reviews A's terminal outcome against it | Prompt doctrine |

The plain goal tools have **no atomic creation path**: `trigger_goal_task` accepts only
`goal_id`, while `create_standalone_task` accepts `depends_on` but creates a task with
no goal link — and unlinked tasks do not report outcomes through the goal notification
loop (`handleTaskTerminal` ignores them). Two shipped shapes:

- **Standalone gated task:** `create_standalone_task(depends_on=[A's task])` for the
  specific artifact-bound step. Runtime-enforced from creation, but outside the goal's
  outcome loop — nothing wakes the launcher when it finishes or fails (`space.task.updated`
  is not an LH wake source, and polling is forbidden), so the launcher must arm a durable
  reminder (`create_agent_reminder`, one-shot by construction) when the dependency can
  release the task, and **re-arm after every nonterminal inspection** until the task
  terminalizes — bounded, escalating to the human instead of re-arming forever. Prefer
  the Forge shape when the goal has a scope: its goal link produces a real outcome wake.
- **Forge-proposal gated task** (atomic, goal-linked): when the dependent goal has a
  linked Forge scope (`create_forge_scope_from_goal`), `create_forge_task_proposal` →
  `create_task_from_forge_proposal(depends_on=[A's task])` persists `goalId` and
  `dependsOn` in one transaction, so the gated task reports outcomes through the goal
  loop. It does **not** claim the goal's single active-task pointer — acceptable for a
  hard-gated side step, which should not occupy the goal's serial slot anyway.
- **Rebinding on retry:** dependencies bind to a specific task ID — and a **pre-start**
  cancellation of A produces no outcome wake at all (the reportable-terminal predicate
  treats a `startedAt: null` cancellation as administrative), so with the pattern's
  no-cadence default the launcher learns of it only from its own reminder: arm one
  whenever a pre-start gated prerequisite is at risk. When A's gated
  prerequisite task terminally fails and the doctrine re-triggers a fresh A task, the
  gated B task stays bound to the dead ID — a pre-start gated task is not even visibly
  blocked (it remains `open` but unschedulable, since only running dependents get
  `dependency_failed`). Rebind B with `update_task(depends_on=…)` when B is still
  `open`/`blocked` — that path only reopens `blocked` dependency-reason tasks, so a
  **cascade-cancelled** B (A was cancelled) must instead be recreated. If the cancelled
  gated task had **started**, dispose its outcome notification first (an active-work
  cancellation produces one; a pre-start cancellation produces none — the
  reportable-terminal predicate is administrative-terminal for `startedAt: null` — so
  do not wait for a notification that cannot exist; the standalone shape never
  produces one). Recreation of the
  Forge shape requires a **new** proposal: re-invoking `create_task_from_forge_proposal`
  on the already-`created` proposal returns the cancelled task (`created: false`)
  without producing fresh work.

The tempting alternative — `trigger_goal_task` on B, then attaching `depends_on` with
`update_task` — is **rejected as unsafe**: if dispatch already started the task, adding
an unmet dependency transitions it to terminal `blocked` (`dependency_added`), which
fires the goal terminal seam, clears the goal's `activeTaskId`, and records a **false
terminal outcome**; the later dependency unblock reopens the task without reclaiming
the goal pointer, so a second goal task can run concurrently with the supposedly gated
one, and the task's workflow run is never stopped. An atomic `depends_on` on the plain
goal-linked creation tools is recorded as the top deferred primitive in §7.

**Partial-completion semantics.** Observable sync events are **task-terminal outcomes** —
per-goal execution is serial and outcome notifications fire at reportable terminal
transitions, not mid-task. A gate that must release "when A's contract fields are frozen"
therefore binds to the task that freezes them: split A's work into goal-linked tasks whose
boundaries are the gate-worthy milestones ("RPC + migration merged, fields frozen" as its
own task) rather than expecting mid-task milestone events. This is a real limitation of
prompt-only, accepted deliberately (§7 records the revisit trigger).

## 6. Failure handling and backoff

| Failure | Existing mechanism | Launcher doctrine |
| --- | --- | --- |
| Launcher misses a wake (asleep/restarted) | Pending notification + inactivity nag; identity-less discovery via `review_goal_outcome()` | Respond on the next wake or launcher reminder. Goals in a launcher objective therefore default to **no check-in schedule**: while an outcome sits unreviewed, the goal's own check-in fire would create a new task from stale `nextSteps` on the cleared pointer, and any goal mutation — including a `pause_goal` — bumps the revision so the pending outcome's goal-state update is CAS-rejected. If a cadence must be retained, **clear it before triggering** (`update_goal` `check_in_cron_expression: null` — the MCP schema field is snake-case) and keep it cleared through outcome review — the trigger→pause sequence is non-atomic (`space.task.created` is published before `trigger_goal_task` returns, so a fast-terminating task records its notification before any pause, and the pause's revision bump then rejects the review as `stale_revision`). Restore the cadence only after the replacement task's outcome is **reviewed**, not merely claimed — restoring is itself a post-trigger revision bump |
| Launcher wakes but never reviews | Nag re-prompts the **same** agent — but only if the inactivity watchdog is configured and **enabled** for the launcher agent (`inactivity_config_set` + `inactivity_config_set_enabled`; a freshly created launcher has neither, so deployment must set it up or the asserted backstop does not exist); there is no auto-escalation on repeated ignored wakes | Accepted v1 failure mode, stated honestly: a wedged owner leaves notifications pending indefinitely. Pending notifications have **no human-facing surface today** (no web/RPC query exposes them) — humans can only infer trouble from stalled goal state. Notification visibility plus bounded escalation are folded into the deferred primitive (§7) |
| Daemon restart mid-loop | Unconsumed notifications persist in the terminal transaction and are recovered at startup; an **acknowledged** notification is terminal and never redelivered — so a restart inside a multi-call sequence (acknowledge-then-cancel, acknowledge-then-trigger) loses the wake with work half-done | Arm a durable reminder **before** acknowledging in any multi-call sequence, so an interrupted loop still wakes the launcher to re-derive state from goals and tasks; do not treat the multi-tool loop as transactionally restart-safe |
| A's task fails or blocks | Reportable-terminal outcome wake reaches launcher; the terminal seam has already cleared the goal's active-task pointer — unless `autoTriggerNext` had a queued successor, which is auto-created and claimed inside the terminal transaction (§4 disables this; reconcile through the drift sequence if found) | **Dispose the failed outcome first** — acknowledge it with the retry reason as its goal-state update — then re-trigger: claiming the replacement task bumps the revision, so a review attempted after the trigger is rejected `stale_revision`. Re-trigger with `trigger_goal_task` (the goal-linked path that reclaims the pointer via CAS), at most twice with recorded reasons — **not** `retry_task`: it reopens the task without reclaiming the pointer, so a check-in or later trigger can start a concurrent task and break serial execution. Rebind any gated dependent task to the fresh prerequisite ID (§5). A retained check-in cadence follows the §6 rule — cleared before triggering and kept cleared through the replacement's outcome review, so the goal stays active and directly triggerable; restore the cadence only after that review — **except on the exhaustion branch, where A's cadence is never restored**. If retries are exhausted: (0) ensure A's goal is paused and its cadence left cleared **before** any teardown — A's pointer is empty and a firing check-in would launch a third attempt beyond the limit; (1) ensure B is paused (a hard gate will have paused it already, and `pauseGoal` accepts only active goals — an existing paused state satisfies this); (2) cancel B's active task (`cancel_workflow_run: true` where applicable) **and the tracked gated task** — a still-open gated task survives the pause and auto-starts if a human later retries A to `done`; (3) dispose every pending notification the cancellations produce (a goal-linked cancellation yields one); (4) record in `nextSteps` and escalate (below). (`reassign_task` is also currently inert — it ignores its assignment arguments.) |
| Contract drift after B started | A's follow-up outcome wakes launcher; the revision gate protects **A's** rolling state only when the review carries a goal-state update (§4 requires one) | Pause B, cancel its active **and tracked gated** tasks (`cancel_workflow_run: true` for workflow-backed ones), dispose all resulting notifications, record the fresh contract, resume, re-trigger (§4 ordering). Known limitation: the CAS does not extend to B — updating B goes through `update_goal`, which has no observed-revision parameter, so a concurrent human edit to B can be overwritten (last-writer-wins; §7) |
| Deadlock (every goal waiting on another) | None — this is a judgment state | Doctrine: set an agent reminder (`create_agent_reminder`) **before** pausing — `pause_goal` also pauses the goal's check-in schedule, so check-ins cannot serve as the safety net while paused — then pause dependent goals and escalate to the human; never spin |
| Human decision needed | `send_session_message` to the Space chat / coordinator session (checks the **minimum of the Space and launcher-agent autonomy levels — both must be ≥4**; template creation assigns the template's suggested level capped by the creator's, so a fresh launcher can silently be below it); below that: durable high-priority draft task + the decision recorded in goal `nextSteps` | Escalate by pausing the blocked goals and stating the decision needed in one place; do not hold blocked work "in flight". Treat Space and launcher autonomy ≥4 as deployment prerequisites for the messaging path |

Backoff policy: cross-goal re-evaluation rides the launcher's own reminders and the
**gating** goal's outcome wakes — pattern goals default to no check-in schedule (§6
explains why a firing check-in is not a benign re-evaluation wake), and a gated (paused)
goal's schedule is suspended by design. Within a goal, the existing single-active-task +
queued-follow-up shape already prevents overlap storms; the launcher adds no polling.

## 7. Decision

**Prompt-only.** Build no new runtime primitive or behavior. The follow-up spawned from
this RFC is prompt content — a launcher template registered in the daemon's existing
`LONG_HORIZON_AGENT_TEMPLATES` array, contract embedded in the template's `instructions`
(§4; `create_agent_from_template` copies them, and no shared session-builder append is
needed) — plus a section in #2537's usage doc. Once the workspace creation parameters ship
(#2531/#2535), the doctrine is also usable zero-code via any LH agent's `instructions`
(§4). No new pipeline logic is introduced, so the
epic's superpipe guidance (ADR 0004) does not engage; if a deferred primitive below is
ever built, its admission/binding logic composes as a direct superpipe pipeline.

**Why.** Every load-bearing mechanism is verified shipped or in-flight (§3): per-repo
goal/task binding, serial per-goal execution, durable owner wakes with CAS disposal,
`depends_on` (the standalone gated-task shape in §5), pause/resume, reminders/check-ins,
and a nag backstop. The pattern itself is unproven — prompt doctrine must be exercised
on a real deployment before primitives are justified, the same sequencing discipline
ADR 0004 applies to new combinators.

**Deferred primitive candidates, with explicit revisit triggers.**

1. **`depends_on` on the plain goal-linked creation tools** (atomic hard-gate creation
   without the Forge-scope prerequisite or the active-task-claim caveat; removes the
   §5 visibility gap and its unsafe attach alternative) — the most likely first
   primitive; revisit when a real launcher deployment uses hard gates at all.
2. **Cross-goal dependency** (goal-level `depends_on` or gate events, UI-visible) —
   revisit after ≥2 real launcher deployments show repeated premature triggers of the
   dependent goal, or humans routinely needing to see the gate in the UI.
3. **Mid-task milestone events** — revisit when a scenario genuinely needs sub-task
   granularity and task-splitting proves too coarse.
4. **LH-agent `send_message`** — revisit only with a steering need `send_message_to_task`
   cannot reach.
5. **Bounded escalation + visibility for ignored outcome wakes** (coordinator/human
   notification after N ignored nags, and a human-facing surface for pending
   notifications, §6) — revisit once a real deployment shows the accepted failure mode
   actually occurring.
6. **Revision CAS on `update_goal`** (observed-revision parameter, so dependent-goal
   updates get the same staleness protection outcome reviews already have, §6) —
   revisit when concurrent human/agent goal edits cause a real lost update.

**Rejected alternatives.**

- *Build a new primitive now*: fails the evidence bar; risks encoding an orchestration
  model before one has run.
- *Cross-Space orchestration*: out of scope — goal/task tools and message delivery are
  per-Space, so objectives whose repos live in different Spaces need cross-Space
  primitives that nothing here justifies yet (§1 prerequisite).
- *Orchestrator session spanning both repos*: violates one-session-one-repo and puts the
  coordinator inside the repos it is supposed to arbitrate.
- *Do nothing (no prompt artifact)*: the pattern works only if the doctrine is written
  down; ad-hoc per-agent improvisation is exactly what the standing prompt contracts
  (`LONG_HORIZON_OWNER_REVIEW_CONTRACT`) exist to prevent.

## 8. Follow-ups (out of scope here)

Implementation issues spawned from this decision: the launcher prompt template slice
(template registration + contract append, mechanical per §7), the usage-doc section
(with #2537), and — only on hitting a §7 revisit trigger — a primitive proposal. Nothing
in this RFC requires new daemon behavior.
