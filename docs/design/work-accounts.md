# Dispatch loop, step 1: an account for every piece of work

Status: proposal, 2026-11-25. Design only.

## The loop

HyperNeo should get cheaper for each installation the longer it runs: record what work cost
and how it ended, sum it up every night, let Neo change how it hands out work, check the
result, and go back when it got worse. The models, plans and kinds of work differ per
installation, so core holds the loop and no model table.

1. **Record (this document).** Routing rules stay as they are; requiring a kind can change
   which saved route matches a new todo.
2. Report: a nightly summary from the recorded numbers, and Neo's suggestions.
3. Act: Neo follows a policy inside the human's rules, tries other lines on a small share of
   reversible work, and the policy is rolled back when it is worse.

Steps 2 and 3 get their own designs after a week of data.

## What an account holds

| Fact | Where |
|---|---|
| who did it: harness, model, effort, role | `neo_todo_sessions`, `neo_todo_roles`; recorded today |
| kind of work | `named.workKind`; exists, rarely filled |
| estimated size | new core fact `estimate` |
| tokens, rounds, context, time | new `usage` on `work_turns` |
| actual size and rework | from the pack of the todo's check |
| outcome, questions to the human | `neo_todos`, `neo_questions`; recorded today |
| project | the ask's project, else the repository the pack reads from the todo |

An account is read by joining these. There is no account table: every fact has one home.
Only numbers and ids are stored, never conversation text, and nothing leaves the machine.
No price is stored, because prices change and plans have none; step 2 converts. A number that
could not be read is absent, never 0. Failed and removed todos have accounts too.

## 1. Kind and estimate on a todo

**Kind.** It says what the work is for, so that like is compared with like. Core adds
`investigate` (find a cause), `operate` (do something in a tool or on a machine) and `design` beside `general`. Coding keeps `coding.write`, `coding.review` and
`coding.verify`; other packs add theirs through `workKinds`. `neo.todo.add` and
`neo.ask.propose` refuse a todo with an instruction and no known kind, and list the kinds.
Todos the daemon makes itself may have none and count as missing. Saved `routes` and line
rules already read this field (`model-lines.md`). Today a todo without a kind counts as
`coding.write` when coding picks its line and as `general` when a held line is moved. Its real
kind can match another saved rule or none, which is what the human's rule says. With no saved
routes or line rules, line selection is unchanged.

**Estimate.** Not "easy" or "hard", which nobody can check, but numbers that can be compared
with the result: `estimate: {files, lines, testLines, by}` for a kind that changes files,
`{steps, by}` for the others. `NeoWorkKind` says which. A review needs none: its size is the
size of the pull request, known before it starts. `by` is `design` or `neo`.
It is given only when the todo is added, together with the kind, and cannot be changed
later. Nothing has to tell when a worker began, and it needs no model call of its own.

**Where a good estimate comes from.** The change plan of a design gives every PR a line
`Estimate: N files, N lines, N test lines`, after `system-map impact` on the planned files
and measuring the touched code, as `AGENTS.md` already asks.
The todo that builds it copies the line with `by: design`. Work without a design is estimated
by Neo, and the two sources are compared after a week.

What the measurements say (251 merged code PRs of one week; size as finally changed):

| Rank correlation with cost | Codex, 199 | Claude, 52 |
|---|---|---|
| all lines | 0.65 | 0.28 |
| test lines | 0.63 | 0.31 |
| code lines | 0.52 | 0.18 |
| code files | 0.43 | 0.33 |
| files that import the changed ones | 0.44 | 0.17 |
| files linked by operation, event or table | 0.39 | 0.04 |

- Size explains part of the cost. Even with the exact final lines, the Codex cost is typically
  off by 1.6 times. The same 21-60 code lines took 12 to 112 rounds (p10 to p90).
- The system map adds nothing once lines and files are known (36% against 37% of the Codex
  cost variance explained). Given half the changed files, it lists 64% of the rest but also a
  median of 67 candidates. So it helps the author of an estimate not to miss files; it is not
  an estimate.
- Todo instructions are not a source: of 430 todos with one PR, 52% name a file, and 64% of
  those name none of the files that changed.

**Actual difficulty** is computed in step 2, not stored: rounds divided by the median rounds
of todos with the same model, kind and actual size. Below 8 such todos it falls back to model
and kind, and below 8 of those it is unknown. So a wrong size estimate and hard work of a
normal size are told apart.

## 2. Usage on turns

`work_turns` already holds one row for each finished worker turn, read by each adapter's
`turns` and caught up after a restart. It gets one column, `usage` (JSON): per model `rounds`,
`input` (uncached), `cacheRead`, `cacheWrite`, `output`; for the main conversation
`context: {first, peak}`; and `usageComplete`, which says whether all cost is included.
This differs from `work_turns.complete`, which describes whether the turn was fully read.

**Which todo a turn belongs to** is not stored with the turn, because a turn can be recorded
after its todo has moved and the binding in `neo_todo_sessions` is gone (`reopen`, redispatch,
retry). It is read from `work_delivery_inputs`, which those do not touch: one row for every
start and send, with the todo, the worker and the time. An adoption gets a row there too,
verb `adopt`, with no message and already delivered: the binding's `boundAt` is replaced by a
rebind and cleared by a move, the row is not. Readers that match a message or wait for a
delivery skip `adopt` rows. Coding already
reads it for pull requests (`codingTurnTodos`); that decision moves to core with two more steps:

1. The todo whose delivery receipt names an input of the turn. Two such todos: none.
2. Otherwise the todo of the worker's newest delivered row (`start`, `send` or `adopt`)
   accepted before the turn started.
3. Before any of those, the todo that started the worker (`work_started_sessions`). Turns of an
   adopted session before its adoption have none.

Measured on 3677 turns of one week: 962 have a receipt, 3 of them of two todos. For the other
959 the time rule alone gives the same todo 954 times. The 2715 without a receipt all get a
todo, but nothing checks it yet; how often that todo is right is part of **Done when**.
All 987 started or sent todos of that week have a row. The worker and the daemon run on one
machine and share its clock. The role is the worker's newest one for that todo in
`neo_todo_roles`, else `do`.

| Adapter | Source |
|---|---|
| Codex | `token_usage_record` lines of the turn, model from `turn_context`; cached and cache-write tokens are subtracted from `input_tokens`, which includes them |
| Claude Code, Claude Desktop | `message.usage` of assistant rows; one count per message id, since a message has several rows |
| HyperNeo | the same, from the stored assistant messages |
| others | no `usage` |

A Claude turn that started a subagent has its cost in another file. It is not read here; the
turn gets `usageComplete: false`, so the account says it is too low. Rows from before the change
have no `usage`.

## 3. Size and rework from packs

A new optional pack hook returns, for a list of todos, `{files, lines, testLines}` and
`rework` as named counts. Core does not know what they mean. Coding implements it:

- **Size.** When a todo's PR merges, coding reads its file list once and stores the totals with
  the PR. Which path is a test or a document is a rule of the pack. Lock files and snapshots do
  not count. For a review todo it is the size of the reviewed PR.
- **Rework.** The PR ledger counts entries into `changes_requested` and into `failing`, once
  per head.

## 4. Reading

One read operation, `neo.todo.accounts {since, until}`, returns the rows and the share of
recorded worker turns in that interval with no todo. Neo may call it.
Step 2 is its first consumer; until then it proves that the records are complete.

## Not in this step

No routing policy changes, no report, no settings, no trial of other lines. The compaction limit is no longer
one of the loop's knobs: later rounds of the same todo are not compacted (`session-reuse.md`). How much
context a todo adds by itself (`peak - first`) is recorded, to see work that was cut too large.

## Changes

Six PRs from `dev`, in order, failing tests first. System map read for the planned files.

1. **Turn to todo.** The decision in core and the `adopt` row; coding uses it and keeps its stricter reading of an
   uncertain turn. Tests: a turn recorded after `reopen`, a redispatch, a retry and a restart
   keeps its todo; a failed delivery gives nothing; a receipt beats the time; two todos in one
   turn give none; a started worker's first turn, which begins before its receipt; an adopted
   session's earlier turns have none; after an adoption, a rebind and a move keep the adopted
   todo for the turns between; a reviewer keeps its role.
   Estimate: 6 files, 110 lines, 200 test lines.
2. **Kind and estimate.** Core kinds, the checks on the two operations, the fact, the Neo tool
   text, and the estimate line in `AGENTS.md` for designs. Tests: missing or unknown kind is
   refused; a pack's kind is accepted only while the pack is on; changing an estimate after
   the todo is added is refused; a daemon-made todo without one is accepted; a todo with
   a kind matches the saved rules of that kind, and one without keeps today's fallbacks.
   Estimate: 8 files, 130 lines, 150 test lines.
3. **Turn usage, Codex, and the column.** Migration and `usage` on `WorkTurnFact`. Tests on real
   rollout shapes: cached input is not counted twice; a turn read in two parts has one total;
   an old row has no usage.
   Estimate: 6 files, 130 lines, 170 test lines.
4. **Turn usage, Claude and HyperNeo.** Tests: several rows of one message count once; a
   subagent turn is incomplete; another model in the same turn is kept apart.
   Estimate: 4 files, 110 lines, 180 test lines.
5. **Size and rework.** The hook and coding's implementation. Tests: test and document paths,
   lock files, more files than one page, a hand merge, a head counted once, a todo with two
   PRs.
   Estimate: 6 files, 150 lines, 200 test lines.
6. **The read operation.** Tests: a failed todo, a todo with two workers, a missing pack hook,
   an unattributed turn.
   Estimate: 4 files, 120 lines, 150 test lines.

**Done when**, one week after the last PR: at least 95% of finished todos that had a worker of
the three adapters have kind and an estimate when required (or the reviewed PR's size for a
review); at least 95% have complete usage. Turns with omitted subagent cost count as incomplete,
not zero. The share of unattributed turns is below 5%. For 20 turns without a receipt, picked at
random, the todo read from the worker's own transcript matches the given todo at least 19 times;
a wrong todo counts as a miss, not as attributed. For 20 todos with complete usage, picked
at random, the totals match the harness's own records.

## Limits

- A turn of two todos has none, and so has an uncertain start whose worker was never found. A
  turn the human starts in a worker counts for that worker's newest todo.
- Work Neo does in its own conversation has no todo and no account.
- A worker on another daemon is recorded by that daemon.
