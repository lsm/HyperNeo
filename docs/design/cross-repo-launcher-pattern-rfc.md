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
  repo directly; every repo mutation flows through a goal-linked task bound to that repo.
  This respects one-task-one-repo and one-session-one-repo, keeps each repo's PR frozen
  per run, and keeps the orchestrator's deliverable — goal state and gated sequencing —
  out of the repos it coordinates.
- One launcher owns the whole objective. Workers stay single-goal and single-repo; they
  report outcomes in their tasks and do not see the other goal (per the existing
  owner-review contract division).

**Prompt surface (the only artifact this decision produces).**

The doctrine is prompt content, deliverable two ways:

- **Zero-code (usable today):** any LH agent can carry the doctrine in its
  `instructions` (`create_agent` / `update_agent`) — `buildLongHorizonAgentSessionConfig`
  already appends agent instructions to every LH session prompt.
- **Packaged:** a long-horizon template family file (e.g. `cross-repo-launcher.md`,
  alongside `release-manager.md` and peers), registered in the daemon's
  `LONG_HORIZON_AGENT_TEMPLATES` array, plus a `CROSS_REPO_LAUNCHER_CONTRACT` append in
  `buildLongHorizonAgentSessionConfig`. This is mechanical registration/wiring of
  existing prompt machinery, not new runtime behavior (§7).

The `CROSS_REPO_LAUNCHER_CONTRACT` block extends the owner-review contract with:

- **Declare the contract between goals** in each goal's `nextSteps`: what each goal is
  waiting on, in terms the other goal's task outcomes can satisfy ("B 2.4.0 waits on A
  task #N done: RPC + migration merged; field names frozen as listed").
- **Choose the gate mechanism per coupling** using the taxonomy in §5 — hard artifact
  gates become `depends_on`; judgment gates become withheld `trigger_goal_task` calls
  recorded in `nextSteps`.
- **Keep one leading goal.** At least one goal always has an active or triggerable task;
  if every goal is waiting on another, pause the dependent goals and escalate (§6).
- **Correct on drift.** When a gating goal's later outcome invalidates dependent work,
  terminalize the dependent goal's active task first — `cancel_task` runs the goal
  terminal seam (clears the goal's `activeTaskId`, cascades to dependents, and yields a
  claimable outcome notification the launcher acknowledges with the supersession reason)
  — then `trigger_goal_task` against the fresh contract. (`interrupt_session` alone only
  stops the current turn; the task stays active and a subsequent `trigger_goal_task`
  would throw or merely queue.) Record the supersession in `nextSteps`.
- **No tight loops.** Cross-goal re-evaluation rides goal check-ins and reminders — the
  scheduling guardrail's durable-vs-transient rule already forbids in-turn polling for
  durable concerns.

**Tool surface.** Unchanged: the existing 86 `space-agent-tools`. The loop concretely
uses `create_goal`, `trigger_goal_task`, `review_goal_outcome`, `update_goal`,
`pause_goal`/`resume_goal`, `list_goal_tasks`/`get_task_detail`,
`create_standalone_task` (`depends_on`), `update_task` (attach `depends_on`, §5),
`retry_task`, `cancel_task`, `send_message_to_task`, `create_agent_reminder`,
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
| Hard artifact gate (B's task cannot start without A's artifact) | `depends_on` between the Space tasks — see the two viable shapes below | Runtime: blocked until the dependency is exactly `done` (`approved`/`review` do not release it); a cancelled dependency cascade-cancels dependents, a failed one blocks them with `dependency_failed` |
| Judgment gate (partial completion quality must be reviewed) | Launcher withholds `trigger_goal_task` on B until it reviews the gating outcome; condition recorded in B's `nextSteps` | Prompt doctrine + serial per-goal execution |
| Durable wait (A slipped/blocked indefinitely) | `pause_goal` on B with the wait recorded; `resume_goal` when released | Prompt doctrine; visible in goal state/UI |
| Milestone release (partial completion of A releases B) | Milestones listed in A's `nextSteps`/`metrics`; B's gate names the milestone; launcher reviews A's terminal outcome against it | Prompt doctrine |

The hard gate has **no atomic creation path today**: `trigger_goal_task` accepts only
`goal_id`, while `create_standalone_task` accepts `depends_on` but creates a task with
no goal link — and unlinked tasks do not report outcomes through the goal notification
loop (`handleTaskTerminal` ignores them). Two viable shapes, both using shipped
behavior:

- **Goal-linked + fail-safe attach:** `trigger_goal_task` on B, then immediately
  `update_task(depends_on=[A's task])`. If dispatch already started the task, the
  runtime blocks it with `dependency_added` — the race fails safe into the blocked
  state rather than wrong execution. Outcome reporting stays on the goal plane.
- **Standalone gated task:** `create_standalone_task(depends_on=[A's task])` for the
  specific artifact-bound step. Runtime-enforced from creation, but outside the goal's
  outcome loop — the launcher tracks it with `get_task_detail`/`list_tasks` instead of
  receiving a wake.

The missing atomic path (accepting `depends_on` on goal-linked creation) is recorded as
a deferred primitive in §7.

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
| Launcher misses a wake (asleep/restarted) | Pending notification + inactivity nag; identity-less discovery via `review_goal_outcome()` | None needed beyond responding on the next wake or check-in |
| Launcher wakes but never reviews | Nag re-prompts the **same** agent; there is no auto-escalation on repeated ignored wakes | Accepted v1 failure mode, stated honestly: a wedged owner leaves notifications pending indefinitely — visible to humans as pending notifications and stalled goal state in the UI. Bounded escalation is a deferred primitive (§7) |
| Daemon restart mid-loop | Notifications persisted in the terminal transaction; startup recovery; inbox replay | None needed |
| A's task fails or blocks | Reportable-terminal outcome wake reaches launcher | `retry_task` at most twice with a recorded reason, then `pause_goal` on both goals, record in `nextSteps`, escalate (below). (`reassign_task` is currently inert — it ignores its assignment arguments and returns the task unchanged — so it is not a recovery step.) |
| Contract drift after B started | A's follow-up outcome wakes launcher; goal-revision CAS protects B's state | Cancel B's active task through the goal terminal seam (`cancel_task`), acknowledge the resulting outcome notification with the supersession reason, re-trigger against the fresh contract (§4) |
| Deadlock (every goal waiting on another) | None — this is a judgment state | Doctrine: pause dependent goals, escalate to the human; never spin. Goal check-ins act as the safety-net re-evaluation timer |
| Human decision needed | `send_session_message` to the Space chat / coordinator session; `create_agent_reminder`; durable high-priority task | Escalate by pausing the blocked goals and stating the decision needed in one place; do not hold blocked work "in flight" |

Backoff policy: cross-goal re-evaluation never runs in a tighter loop than the goals'
check-in cadences; reminders cover time-bound gates ("release date reached, A unmerged").
Within a goal, the existing single-active-task + queued-follow-up shape already prevents
overlap storms; the launcher adds no polling.

## 7. Decision

**Prompt-only.** Build no new runtime primitive or behavior. The follow-up spawned from
this RFC is prompt content — a launcher template registered in the daemon's existing
`LONG_HORIZON_AGENT_TEMPLATES` array plus a `CROSS_REPO_LAUNCHER_CONTRACT` append in
`buildLongHorizonAgentSessionConfig` (mechanical wiring of existing prompt machinery,
§4), and a section in #2537's usage doc. Until that lands, the doctrine is usable
zero-code via any LH agent's `instructions`. No new pipeline logic is introduced, so the
epic's superpipe guidance (ADR 0004) does not engage; if a deferred primitive below is
ever built, its admission/binding logic composes as a direct superpipe pipeline.

**Why.** Every load-bearing mechanism is verified shipped or in-flight (§3): per-repo
goal/task binding, serial per-goal execution, durable owner wakes with CAS disposal,
`depends_on` (with the two fail-safe shapes in §5), pause/resume, reminders/check-ins,
and a nag backstop. The pattern itself is unproven — prompt doctrine must be exercised
on a real deployment before primitives are justified, the same sequencing discipline
ADR 0004 applies to new combinators.

**Deferred primitive candidates, with explicit revisit triggers.**

1. **`depends_on` on goal-linked task creation** (atomic hard-gate creation; removes the
   §5 attach race and the standalone-task visibility gap) — the most likely first
   primitive; revisit when a real launcher deployment uses hard gates at all.
2. **Cross-goal dependency** (goal-level `depends_on` or gate events, UI-visible) —
   revisit after ≥2 real launcher deployments show repeated premature triggers of the
   dependent goal, or humans routinely needing to see the gate in the UI.
3. **Mid-task milestone events** — revisit when a scenario genuinely needs sub-task
   granularity and task-splitting proves too coarse.
4. **LH-agent `send_message`** — revisit only with a steering need `send_message_to_task`
   cannot reach.
5. **Bounded escalation for ignored outcome wakes** (coordinator/human notification
   after N ignored nags, §6) — revisit once a real deployment shows the accepted
   failure mode actually occurring.

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
