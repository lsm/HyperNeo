# Work delivery and liveness guarantees

Status: proposed implementation plan. Investigation base: `10f17a0a0067264c9b0de431a9334ef01c331532`
(`origin/dev`, 2026-10-20). This page changes no runtime behavior. The human has
approved proceeding with small implementation PRs after this document passes review.

## Root cause and evidence

The first wrong decision is treating a dispatch claim as worker progress. The
second is treating absence from one adapter's discovery store as execution death.
Neither decision is tied to an input, a verified execution owner and a deadline.

Source references below are repository-relative `file:line` at the investigation base:

| Path | Decision and consequence |
| --- | --- |
| `packages/daemon/src/lib/drivers/work-operations.ts:599` | `work.send` exposes adapter-specific auto/steer/queue semantics; accepted submission is explicitly not completion. Local/remote routing does not supply a common delivery supervisor. |
| `packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts:318` | `claimStart` writes `doing` and a todo start timestamp **before** invoking the adapter. This proves only exclusive dispatch admission. |
| `packages/daemon/src/lib/neo/todo-runner.ts:282` | Dispatch probes the existing session, invokes start/send, then records the ref and optional receipt. `readDriverOutcome` at `neo/driver-work.ts:130` converts `delivered:false` to `queued` but drops `queuedSubmissionId` and `unconfirmed`. Todo-session start evidence can be null while the todo remains doing. Continue repeats this at `todo-runner.ts:624`. |
| `packages/web/src/lib/i18n/en.ts:61` | `doing` is labelled “In progress”; the projection overstates the claim's evidence. |
| `packages/daemon/src/lib/drivers/codex-desktop-handoff.ts:14` | Auto send discovers the Desktop owner and steers its active turn. A confirmed no-active-turn refusal selects queue; pre-dispatch unavailability selects app-server. Ambiguous post-dispatch steering errors do not queue again. |
| `packages/daemon/src/lib/drivers/codex-desktop-adapter.ts:893` | App-server steering checks the latest turn for `inProgress`; absence in auto mode falls through to queue. |
| `packages/daemon/src/lib/drivers/codex-desktop-adapter.ts:793` | Queue calls `thread/queue/add`, or `codex queue` for unsupported/unreachable server paths. `delivered:false` plus `queuedSubmissionId` means queue insertion succeeded but a fresh matching rollout input was not observed. It does **not** mean a running turn exists. This path does not wake an idle owner or call `thread/queue/start`. |
| `packages/daemon/src/lib/drivers/codex-desktop-adapter.ts:1106` | New-thread start separately creates a thread and asks Desktop to start its opening turn; `codex-desktop-handoff.ts:124` opens the link, discovers an owner and requires a returned turn ID. Start and send therefore have different activation guarantees. The returned start status/time is still not first-output evidence. |
| `packages/daemon/src/lib/neo/settle-driver-work.ts:55` | Settlement attempts to anchor matching input and conservatively refuses unrelated old output. `neo/driver-work.ts:350` uses baseline plus opening-text matching when no stronger receipt exists. No input is a reason to keep waiting, without a delivery deadline. |
| `packages/daemon/src/lib/neo/todo-runner.ts:529` | Idle reminders require doing, instruction, **report**, ref, an open ask, no pack wait and stopped/done status. Only then do 30/60-minute reminders and a 90-minute block apply. Never-started/no-report is excluded; reminder `ok:true` counts even if queued. |
| `packages/daemon/src/lib/neo/driver-work.ts:268` | The 24-hour unconfirmed threshold affects status projection; it neither retries delivery nor creates a durable delivery-failure notification. `todo-runner.ts:250` also suppresses idle-ask notices when any todo is doing/blocked. |
| `packages/daemon/src/storage/repositories/neo-todo-session-repository.ts:59` | Interrupted-start recovery covers doing with no ref; awaiting-report scans cover doing with a ref. False terminal failure removes a live worker from that supervision (`todo-runner.ts:690`). |
| `packages/daemon/src/lib/drivers/claude-desktop-adapter.ts:1200` | Desktop start launches `claude -p` with a CLI UUID, exposes `local_<uuid>` as Desktop identity, and keeps a synthetic record in a process-local cache (`:1259`). Discovery at `:175` combines Desktop records with that cache. Restart can lose the cache before Desktop imports the CLI execution. |
| `packages/daemon/src/lib/drivers/claude-desktop-adapter.ts:535` | Missing Desktop record returns `not_found` before reading the CLI transcript. `neo/driver-work.ts:587` converts it directly to “The work is gone.” Desktop registration and execution existence have been conflated. |
| `packages/daemon/src/lib/drivers/claude-session-owner.ts:73` | Control requires a unique live registration, known CLI/Desktop owner and PID. Unknown ownership correctly refuses control, but no durable start-owner binding repairs this for a worker the daemon created. Never bypass this gate by guessing ownership. |

Read-only observations on 2026-10-20 (SQLite URI `mode=ro`, `query_only=on`):

- `bf97eb09`: now removed by intervention; null delivery start, receipt and report,
  live status queued, repeated checked timestamps. Codex queue still contains item
  `01a15a77-38b4-78a1-bac9-560ebb339df0` for thread `01a1456c…`; thread metadata
  has not advanced since Oct 16.
- `01a15b68…` (fullstack-5): pending items `01a15bfd-0a52-7343-a1f7-2eb25ecd017d`
  and `01a15c25-c8d7-7af3-92ea-7a48cc1cd8db` remain in `queue_1.sqlite`.
  This corroborates the reported #7923 handoff; it does not establish which
  internal Desktop scheduler gate prevented each individual item from starting.
- `0eaeb6e1` and `96dff02c`: failed with missing `local_…` Desktop records, while
  their retained last live status is running. Neo independently observed CLI
  output under the corresponding bare UUIDs. The second worker was later reported
  stopped without a final report; its already-failed todo was outside supervision.
- Neo also reported control of both UUIDs refused with unknown/ambiguous ownership.
  These reports establish the operational symptom; ownership registrations were
  not inspected and their exact disappearance is not attributed here.
- Earlier OAP-1/OAP-2 missing-input reports remain historical leads, not independently
  reproduced in this investigation. The running daemon was reported as `19ffa19cca`;
  its behavior must not be assumed identical to this fetched source or #7927.

Who drains Codex's queue: Desktop's owning conversation scheduler, backed by the
Codex app-server queue, rather than HyperNeo's todo runner. Read-only inspection of
installed `ChatGPT.app/Contents/Resources/app.asar`, asset
`webview/assets/app-initial-3ccf4886957f.js`, found `Tfn` gating automatic dispatch
on conversation presence, owner/follower role, paused state and latest-turn state.
Its queue `resume` path calls `thread/queue/start` after refreshing and checking
eligibility; `sendNow` also starts an idle thread's queued item. The main bundle
`main-CLu1A25j.js` has a queued-thread wake path that lists pending input then
resumes the thread. Thus queue persistence alone is insufficient: an eligible
owner must load/resume and dispatch it. This is version-specific static evidence,
not a supervised Desktop execution trace or proof of a particular gate in tonight's
cases. HyperNeo must own its guarantee across that external scheduling boundary.

Adapter differences matter. Claude CLI inbox submission
(`drivers/claude-inbox-submit.ts:48`) returns unconfirmed after a transport write;
Desktop direct/relay send (`claude-desktop-adapter.ts:914`) polls for transcript
input. The optional Desktop mods channel verifies the connected owner and journals
transport/turn facts (`claude-desktop-mods-control.ts:31`). HyperNeo's adapter
(`hyperneo-adapter.ts:484`) accepts a mailbox handoff and infers delivered from
non-deferred/non-busy state. Its mailbox has delivery jobs, deferred replay, TTL
expiry and dead-letter sender notification (`mailbox/registration.ts:79`), but
those are not a universal worker-start/first-output guarantee. Space-agent inactivity,
provider rate-limit and process watchdogs supervise other lifecycles; none can
replace an input-scoped obligation that also survives a false todo failure.

## One invariant

**Every accepted input has a durable, bounded obligation: either show correlated
worker progress or persist an explicit failure/uncertainty plus a notification to
Neo. A claim, missing discovery row or unrelated session activity can never satisfy
or erase that obligation.**

This rules out silent abandonment, not physical execution failure or exactly-once
execution on an uncooperative external tool. Daemon downtime delays observation;
overdue obligations reconcile before fresh dispatch on restart, with downtime
visible in the evidence. No finite wall-clock guarantee is claimed while all
supervisors are down.

## Durable input and execution model

One operation-owned supervisor serves all adapters; adapters translate commands
and evidence, never invent independent retry policy. Separate todo completion
from execution and delivery. Store each logical input before external effects,
with todo/ask, sender/return address, immutable instruction hash, idempotency key,
daemon, adapter, canonical execution ID, attempt ID, queue/input/turn IDs, verified
owner generation, evidence provenance/time, deadline and terminal outcome. Preserve
explicit queue versus immediate/steer intent. Continue creates another input
obligation instead of wiping the previous evidence. Snapshot and UI read the same
projection; keep legacy `doing` only as workflow compatibility during rollout.

| Delivery milestone | Required evidence | Proposed default deadline / visible label |
| --- | --- | --- |
| accepted | Durable daemon input plus outbox/deadline committed atomically with admission | 30 s to peer acknowledgement; “Dispatch pending” |
| delivered_to_tool | Correlated peer acknowledgement/queue ID; inbox write alone remains unconfirmed | 60 s to turn start when idle; “Queued in Codex” or “Awaiting tool acknowledgement” |
| turn_started | Correlated tool turn ID or verified runtime consumption; steer joins the acknowledged active turn | 120 s to first worker output; “Started; awaiting output” |
| first_worker_output | Correlated worker message/tool event for this input/turn, with provenance | “In progress”; transition to existing completion/idle supervision |
| undelivered / unconfirmed / stalled / cancelled | Typed reason, last evidence, attempt history and durable Neo notification | “Not delivered”, “Delivery uncertain”, “Started; no output”, “Cancelled” |

Durations are initial policy defaults, persisted per obligation, not scattered
timers. Explicit next-turn queue during busy work shows its dependency and a
bounded start-by time (default 30 minutes); completion triggers immediate dispatch.
Expiry escalates to Neo without interrupting the prior turn or silently extending
the deadline. User-approved holds are explicit, auditable states with review times.
Silence after a confirmed start becomes stalled, not evidence of undelivered input.
Tool-only progress can satisfy first output; report-required completion still
requires a final report. Old messages, thread timestamps and matching prompt
prefixes alone cannot promote an obligation to verified progress.

Persist execution identity independently of presentation: a Claude CLI UUID is
the execution; Desktop `local_…` IDs and links are aliases with registration state.
Start records launch PID plus process-generation evidence and canonical ID before
returning. Restart revalidates registration/process generation and transcript;
never trusts PID alone or strips `local_` from arbitrary foreign refs to control it.
Maintain an execution watch independently of todo state until correlated terminal
execution evidence or explicit cancellation. A Desktop lookup miss means
`registration_missing`; missing/ambiguous owner means `control_unavailable`;
transport failure means `observation_unavailable`. None proves execution death.
Positive CLI output outranks missing presentation metadata. Verified exit/terminal
turn settles execution; absent final report is surfaced to Neo. #7927's link
registration change is useful but does not establish this identity contract.

## Activation, recovery and escalation

The supervisor persists an attempt and claims a bounded lease with a generation
fence, sends with the same logical input identity, then consumes receipt/turn/output
events. Indexed due work is also reconciled on startup and periodically, so event
loss or process death cannot orphan it. Fence late results against current attempt
and owner generation; late first-output evidence updates the record and notifies
Neo even after a prior uncertainty alert. Terminal todo state does not destroy an
outstanding execution watch. Cancel stops new delivery attempts and preserves facts.

For idle Codex, activate the existing queued submission through the verified owner
and supported queue-start/wake capability; retain the queue ID and require a turn
acknowledgement. Do not turn a queue ID into a second fresh prompt. For running
Codex, confirmed steer and explicit next-turn queue retain their distinct semantics.
An unsupported owner/wake capability is a typed, visible outcome with a deadline.

At a missed acknowledgement/start deadline, reconcile queue, receipt and owner
first. Re-deliver **once**, only with adapter-supported idempotent consumption of
the same input or confirmed cancellation/non-consumption of the first attempt.
If acceptance is uncertain and duplicate execution cannot be excluded, alert Neo
as unconfirmed instead of replaying. After the single safe retry's deadline, mark
undelivered and notify Neo. After confirmed start, investigate/alert stalled output;
never resend the task as a delivery retry. Authentication and ownership refusals
surface immediately with actionable reason and no retry loop.

State transition, new deadline and a deduplicated notification outbox entry commit
in one transaction. Notifications target Neo and retain delivery status/retry
budget independently; undeliverable notifications appear in the human status
surface on reconnect. Separate worker-completion reminders from delivery alerts.
Track oldest due obligation, missed-deadline count and notification lag; a recent
status read cannot reset a deadline. There is no guarantee if the supervisor
itself can silently stop, so its heartbeat/overdue age must be visible and checked
by the existing daemon health/recovery boundary.

## Migration and verification

Backfill active todos, unresolved sends and adapter-owned queues as **unknown**
unless stronger correlated evidence is available. Never infer execution from
`doing`, its timestamp or an old report. Reconcile failed-as-gone todos with
verified canonical executions too; reopening completion state needs a recorded
repair reason. Import aliases and queue IDs only with unambiguous ownership;
quarantine unrelated or ambiguous queue entries without executing/deleting them.
Overdue legacy inputs notify Neo immediately, and require reconciliation before
any replay. Keep old evidence and historical state transitions. Ship schema and
read projections before enabling control, observe shadow classifications, then
switch admission/supervision atomically. Rollback disables new dispatch, retaining
durable obligations and read/alert support until reconciled.

A synthetic characterization using the production runner and in-memory migrated DB
was run at the base above. Adapter returned accepted/queued while the synthetic
idle session never consumed input. Refresh at +30/+60/+90/+480 minutes observed
`{state:"doing",report:null,startedAt:null,notes:0,sends:1,statusReads:5}`.
Re-runnable script and captured output are local investigation artifacts at
`/Users/lsm/focus/verification/work-delivery-design/{reproduce.ts,reproduction.json}`.
This proves the runner blind spot, not real Desktop scheduling, a real RPC journey
or a repaired runtime. No live writes, credentials, provider, GUI or port 8399 were
used. This design PR's user surface is the rendered Markdown page; runtime proof
belongs to the implementation slices, and no implementation fix is claimed here.

For each implementation slice commit its failing observable regression first.
Use fresh synthetic HOME/data, scripted CLI/IPC peers, isolated real daemon RPC
and snapshot/UI projections following `.claude/skills/verify/SKILL.md`; add a
repeatable journey there in that slice. Never use unattended GUI tests. Required
journeys: idle queue activation; busy queue ordering/expiry; acknowledgement without
start; start without output; output before delayed acknowledgement; restart at
each effect/commit boundary; lost/duplicate events; safe retry and ambiguous-send
no-replay; cancellation/late evidence; disconnected Neo notification recovery;
CLI worker before Desktop import and after daemon restart; ambiguous/reused PID;
missing Desktop row with live CLI output; and stopped CLI without final report
when the todo previously failed. Assert visible state, alert count and absence of
duplicate worker instructions through real operation doors, not helper internals.
Repeat across Codex, both Claude adapters and HyperNeo; incapable peers must expose
uncertainty rather than fabricate progress. Keep version-specific Desktop scheduler
observations separate from synthetic protocol proofs.

## Small PR sequence and merge contract

Each slice starts from updated dev, targets dev, maps to one issue and stays under
300 production lines (tests travel with their slice); split further when measured
scope exceeds that budget. No stacked branches. Construction/wiring/deletion remain
separate where repository ADR 0004 requires them.

1. Pin delivery/identity regressions using synthetic peers and operation projections;
   record current wrong decisions before changing them.
2. Build durable input obligations, event evidence, owner bindings and deadlines;
   schema parity and restart contracts. Split storage concerns if needed.
3. Build shared classification and deadline/retry/notification policy, reachable in
   shadow mode; no delivery effects yet.
4. Wire canonical Claude execution identity and independent liveness watches;
   restart, missing-store and missing-final-report journeys.
5. Wire Codex input-ID retention and idle queued-input activation through verified
   ownership, with busy/steer/uncertain boundaries.
6. Wire common admission, deadlines and recovery for every adapter; include legacy
   reconciliation, sender notifications and downgrade behavior.
7. Wire truthful snapshot/UI delivery labels and operator-visible overdue health;
   verify real web projections headlessly with synthetic data.
8. Delete obsolete timestamp inference and report-gated delivery supervision after
   all paths use the common obligation, retaining completion supervision.

Merge this document and each implementation only after `hyperneo-ai-test` approves
its exact latest head from a run that actually read the code, all CI is green and
review threads are resolved. Squash manually; never enable auto-merge. A blocked
review is reported to Neo and held. No additional human approval is required under
the updated instruction. Send Neo each PR link; remove each worktree after merge.
