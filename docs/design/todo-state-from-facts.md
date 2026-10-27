# Todo state from facts

## The ask is the plan

The plan is the ask’s ordered todos, using their existing position. When Neo
takes an ask with several items or steps, it records every item as a todo at
once, in order, before starting the first. No second plan store or scheduler.
Progress must survive Neo switching tasks or forgetting the conversation.

Add this one sentence to `packages/prompts/src/neo/system/root.md`:

> When you take an ask with several items or steps, add every item as a todo at once, in order, before starting the first.

## Core and packs

Core and packs are fully separate. Core knows only generic facts: the dispatch
record (todo → session, dispatch id), session live status, open questions, and the
worker’s explicit result (“result for todo X” + dispatch id). Core knows nothing
about PRs, CI or merges. A pack answers domain questions through two functions:

- `pack.readFacts(todo)` does the I/O; the coding pack reads its sub-issue and linked PRs from the GitHub ledger.
- `pack.judge(todo, facts)` is pure and returns `done | failed | blocked(reason) | no opinion`.

The pack tells core “facts changed for todos [ids]” to trigger a recompute.
PR→worker messages (CI failed, review, conflict, ready to merge) are the coding
pack’s own job, sent from the ledger only. Move the coding code out of core:

- `service.ts` constructing the ledger/events/sweep repos and the GitHub readers.
- `operations.ts` and project-tree importing github-read/query/ask-prs.
- driver-work’s `/merg/` regex and PR prompts.

Add a CI check: core may not import from `packs/`.

## Coding plans are GitHub epics

Multi-step coding work gets one epic issue and one sub-issue per step. Create
the epic, all sub-issues and all ordered stage todos up front. Each todo uses
`{pack: "coding", kind: "issue_closed", params: {issue: "owner/repo#N"}}`.
Validate `params.issue` as a well-formed `owner/repo#N`.
Existing `pr_merged` todos keep working as they are.
The ask’s todo order drives execution; the epic mirrors that plan on GitHub,
not a second scheduler.

A PR links to its todo through `Closes owner/repo#N` naming that sub-issue.
`pack.readFacts` reads the sub-issue and its linked PRs through the existing
ledger; `pack.judge` says done when the sub-issue closes as `COMPLETED`, failed
when it closes as `NOT_PLANNED`, and no opinion if facts are unreadable. No
additional merged closing PR is required: the PR’s closing link ties the two.
An open sub-issue does not become done just because a worker says so or one PR
has merged. Keep the repository’s review and merge rules. No separate
PR-to-todo link records or second GitHub poller.
For release-branch PRs, the worker explicitly links the PR to its sub-issue in GitHub and, after the permitted merge, closes the sub-issue as `COMPLETED`.

In `packages/prompts/src/neo/packs/coding/instructions.md`, replace “Work in
stages gets one todo per stage, in order” and the old PR-claim/manual-link advice
with:

> For work in stages, create the epic and all stage todos up front, in order, with one sub-issue named by each todo as owner/repo#N; each PR says Closes owner/repo#N for its sub-issue, and the coding pack completes the todo when the sub-issue closes as COMPLETED.

## One state writer

Keep the existing state column and its readers. Only one function,
`recompute(todo)`, may write it. Removal is explicit intent; recompute never touches a removed todo (never resumes or re-dispatches it).

The existing remove operation passes removal intent into this pipeline; its write stage persists `removed` while preserving session-stop and start-question cleanup.

Precedence:

1. **done:** the pack says met; for todos without a pack, the human confirms; a worker’s claim alone never counts.
2. **failed:** the pack says so.
3. **blocked:** an open question; a failed/needs_you session; or the pack says so.
4. **doing:** dispatched.
5. **todo:** not dispatched.

Recompute and store when a fact changes (session status change, question answered,
result submitted, pack notification). Page loads just read the column.

When recompute decides a todo is done, the same pure decision also outputs
“start the next todo in this ask”, or no next todo when the plan is finished.
Choose the next pending todo in ask order; do not skip a failed/blocked step,
resume a removed todo or dispatch one already started. The write stage persists
the decision and starts that todo through the existing start/dispatch path.
Repeated facts or restart must not dispatch it twice: reuse the existing
dispatch record. Neo intervenes only for failed, blocked or question cases;
ordinary progress follows facts, not Neo’s memory or a manual tick.

## SuperPipe and pure functions

`recompute` is a SuperPipe pipeline: read → decide → write.

- `decideTodoState(facts, packJudgement, now)` is pure: no DB, no clock; `now` is passed in. Its facts include the ask’s ordered todos and dispatch records; its output includes state and the next todo to start.
- Stall planning `planNudge(incident, progress, now)` is pure, like `planCodingPrNudge`.
- I/O happens only in the read and write stages, so most verification becomes plain unit tests on data.

## One stall ladder

At 20 min remind the worker, at 40 min remind again, and at 60 min move the todo once
to a fresh worker. If that worker also sits idle for an hour, block the todo as
`stalled` and tell Neo. A session the human started and tracked gets no reminders
typed into it; it goes straight to stalled after an hour idle. Reset the ladder only
on real progress (a reply right after a reminder is not), and persist it so a restart
doesn't reset it. A stalled todo returns to doing when its worker runs or reports
again. The planner is `lib/work-queue/follow-through.ts`. Apart from `stalled`,
a stopped or idle session and “nobody ticked it” are not block facts. A merged/closed coding result
must be judged before considering a reminder, even if the worker has stopped.

## Delete

- The 6 state writers.
- The in-memory idle/checked maps.
- The three result-inference fallbacks.
- The second ladder.
- Time-only blocking and its automatic blocked writes.
- Done-by-manual-tick for pack todos; only the pack’s facts complete them.
- PR-link code replaced by `issue_closed` only (including per-todo card event subscriptions and the `claimed` switch); keep existing `pr_merged` claim records and their path.
- `neoAskIdleNote`.

Dropped from the draft: shadow/dual-run compare, backfill, migration review items,
“intent revision” and “dispatch generation” (keep just a dispatch id). Open todos
are simply recomputed at cut-over.

## Steps

New code is only recompute’s “start next” output and the coding pack reading
sub-issue state; everything else is deletion. Reuse the existing ordered todos,
dispatch/start path, ledger and facts/judgement seam. No new orchestration layer.
Moving existing coding code unchanged into its pack adds no behavior.

Steps 1–2’s behavior pins and facts/judgement seam are merged (#8187 completed
the latter). The remaining cut-over and import cleanup follow below. After this
design is approved, Neo creates one epic with four sub-issues and all four todos
for steps 3–6 before starting step 3. One small PR per step:

3. **Core recompute and plan advancement.** Collapse existing state writes into
   read → pure decide → write and cut over. Include the next-todo output and
   existing dispatch path, plus the root prompt sentence. Pin done → next start,
   final step → no start, repeated facts/restart → no duplicate start, and
   a failed/blocked decision → no advancement; removed stays removed.
4. **Explicit worker results.** Keep the dispatch-id-bound result fact and delete
   the three inference fallbacks. A worker’s prose cannot complete a pack todo;
   preserve existing result/report bytes and the non-pack human confirmation.
5. **Coding sub-issues and the single nudge ladder.** Use `issue_closed` for
   coding judgement and GitHub closing links for PR membership; include the
   coding prompt replacement. Keep ledger-only PR messages. Collapse the two
   ladders into persisted 20/40/60 nudges and delete time-only blocking. Prove a
   COMPLETED issue advances its next todo despite a stopped worker; NOT_PLANNED
   fails, open/unreadable does not complete, and reminders never block.
6. **Finish the core/pack split.** Move the coding code listed above unchanged
   into its pack, deleting the core copies/imports before enabling the import
   check. Remove obsolete PR links, manual pack completion, maps and helpers
   listed above. Re-run the full plan journey.

Each step carries failing contracts before its change and an isolated daemon
journey in the verify skill: observe stored state and actual next-worker
dispatch, including restart and removal, not just a pure-function assertion.
This documentation PR implements none of those runtime changes.

Only the PR-related parts of steps 3 and 5 waited on the GitHub single-source
ledger (#8135); #8135 is already merged as `33e2fd11`, so nothing waits now.

Merge policy is the repo’s saved one: eligible bot approval on the exact current
head, green CI, manual squash, deploy build readback. Put each PR’s worktree under
`~/focus/worktrees/<name>`, remove it when the PR merges or closes, and stop any
test daemon started there.
