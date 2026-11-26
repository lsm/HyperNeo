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
| who did it: harness, model, effort, role | harness: the worker ref's `adapter`, on every turn, delivery row and adoption (`work_started_sessions.harness` exists only for started workers and, where set, equals it); `neo_todo_roles` (role, model, effort), `neo_todo_sessions` (`actual_model`, `actual_effort`); recorded today |
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
retry). It is read from proof of delivery only, never from time. Coding already reads
`work_delivery_inputs` for pull requests (`codingTurnTodos`); the decision moves to core as two
steps:

1. The todo whose delivery keys match the turn's id or inputs, using the same keys as
   `codingTurnTodos`: the normalized receipt input id, `startedTurnId` and `steeredIntoTurnId`.
   Two such todos: none.
2. Otherwise the todo that started the worker (`work_started_sessions.todo_id`), if no row of
   any other todo names that worker, ever: neither as its target (`target.ref`, which every
   send row has, also while pending or after a failure) nor as its outcome (`outcome.ref`,
   which a start row gets). Only a failure marked `notSent` does not count. A start row of
   another todo without a ref cannot name the worker, because a start always makes a new
   session. Nor may another todo have adopted it. Otherwise none.

Adoption leaves no delivery row, its binding in `neo_todo_sessions` is overwritten when the
todo rebinds, and `neo_todo_roles` is no record either (`unclaimTodoWorker` deletes rows, and
a todo's deletion cascades). So a new table, `work_adoptions (todo_id, adapter, id, daemon,
at)`, with no foreign key and no delete anywhere, gets one row from each adopt write (`create`
and `bind` in `neo-todo-session-repository.ts`). `work_delivery_inputs` already has no foreign
key and no delete. A worker started before the `work_adoptions` migration (its
`migration_markers` time) has a history that cannot be known, so it gets no step 2 at all.

Step 2 uses no time: a worker that two todos ever reached gets it for neither, before or after.
`WorkDeliveryInputRepository.list(ref)` matches only `outcome.ref` today; it also matches
`target.ref`. A turn the human starts in a worker that only one todo ever reached counts for that
todo. This is attribution by the fallback, not proof: no delivery fact tells it from a send
without a receipt. The transcript check below counts such turns apart.

A turn with neither has none: an adopted session's turns, and any turn without a receipt in a
worker that two todos reached, whether a send or the human started it.

**Receipts.** A receipt is the harness's own id, returned by the call, for the input or for the
turn that input started: the input id, or a Codex `startedTurnId`. A delivery key is a receipt
or a `steeredIntoTurnId`. In one week of confirmed deliveries: Claude Desktop 1080 of 1080
(sends and starts), Claude Code 73 of 73, HyperNeo 518 of 518, Codex Desktop sends that
started a turn 625 of 625, but Codex Desktop starts only 301 of 492. A Codex start already
receives the opening turn's id and checks it, then drops it (`startCodexDesktopTurn` in
`drivers/codex-desktop-handoff.ts`, and the app-server `turn/start` branch in
`codex-desktop-adapter.ts`); the receipt it returns is found afterwards by reading the
rollout, which can miss. Returning that turn id is one adapter change.

A queued or unconfirmed Codex send gets its key from the id the daemon already chooses for it.
Every Codex Desktop send path passes a fresh `clientUserMessageId` (the app-server
`thread/queue/add` and the Desktop `thread-follower-start-turn`), and when the message runs
Codex writes an `item_completed` event whose user item carries it as `client_id`, with the
`turn_id` of the turn it ran in. The daemon drops that id today. So the outcome keeps it as
`clientMessageId`, the Codex turn reader adds each user item's `client_id` to the turn's
inputs, and `deliveryKeys` matches the two. That is an exact id written by Codex, not time or
text, so it is a receipt. The `queuedSubmissionId` is not kept by Codex (0 of 1732 turn
inputs in a week) and is not used. The stated limits:

- A Claude Desktop send through the relay already returns the input id whenever the relay has
  one (`claude-desktop-adapter.ts`). It has none only when the receiver logged just a queue
  line, which carries no id (`claudeRelayedInput`); then the send is confirmed without a
  receipt. This happened to 0 of 5914 delivered Claude Desktop sends since October; there is
  no id left to return.
- A Codex Desktop steer has no receipt; its `steeredIntoTurnId` is its key.
- A Codex send through the `codex queue` command, the fallback when the app server cannot be
  reached, sends no client id, so it has no key.

A delivery without a key (the relay case and the `codex queue` fallback) gives its
turn a todo only through step 2. A steer has its key and is assigned in step 1. This is a known
limit, not guessed around.

Measured on the 6624 worker turns of one week: 713 (10.8%) have a receipt and 1165 (17.6%) get
the starting todo, so 28% have a todo today. Turn counts and delivery counts above measure
different things: a turn can include more than one delivery, and not every delivery is matched
to a recorded turn. The role is the worker's newest one for that todo in `neo_todo_roles`,
else `do`.

| Adapter | Source |
|---|---|
| Codex | `token_usage_record` lines of the turn, model from `turn_context`; cached and cache-write tokens are subtracted from `input_tokens`, which includes them |
| Claude Code, Claude Desktop | `message.usage` of assistant rows; one count per message id, since a message has several rows |
| HyperNeo | the same, from the stored assistant messages |
| others | no `usage` |

A Claude turn that started a subagent has its cost in another file. It is not read here; the
turn gets `usageComplete: false`, so the account says it is too low. Rows from before the change
have no `usage`.

A todo's usage is complete only when every turn it has is complete and no worker it reached (by
a delivery row, a start or an adoption) has a turn without a todo. Such a turn may be this
todo's work, so its cost is unknown, not zero.

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
recorded worker turns in that interval with no todo, per adapter. Neo may call it.
Step 2 is its first consumer; until then it proves that the records are complete.

## Not in this step

No routing policy changes, no report, no settings, no trial of other lines. The compaction limit is no longer
one of the loop's knobs: later rounds of the same todo are not compacted (`session-reuse.md`). How much
context a todo adds by itself (`peak - first`) is recorded, to see work that was cut too large.

## Changes

Eight PRs from `dev`, in order, failing tests first. System map read for the planned files.

1. **Turn to todo.** The decision in core, and the `work_adoptions` migration; coding uses it and keeps its stricter reading of an
   uncertain turn. Tests: a turn recorded after `reopen`, a redispatch, a retry and a restart
   keeps its todo; desktop-pending receipts and started or steered turn ids give their todo;
   two matching todos give none; a started worker's turns keep its todo while no row of another
   todo names it; a pending send and a failed send without an outcome ref of another todo each
   take step 2 away from every turn of that worker, earlier ones too; so does another todo's
   adoption, also after that todo rebinds elsewhere, is unclaimed or is deleted; a Codex steer
   gives its todo by `steeredIntoTurnId`; a Claude Desktop relay send without an input id gives
   none by step 1; a worker
   started before the migration gets no step 2; a `notSent`
   failure does not; a human-started turn in a worker one todo reached keeps that todo; an adopted session's turns without a receipt have none; a reviewer keeps its
   role.
   Estimate: 8 files, 120 lines, 200 test lines.
2. **Codex start turn id.** The Codex Desktop start returns the opening turn's id from both
   branches as `startedTurnId`, and the start outcome keeps it, so `deliveryKeys` reads it as
   for a send. Tests: a start whose rollout read misses still has its turn id and gives its
   todo; a start whose call returns no turn id still fails as today.
   Estimate: 4 files, 30 lines, 60 test lines.
3. **Codex client message id.** Each Codex Desktop send keeps its `clientUserMessageId` in the
   outcome as `clientMessageId`, queued or not; the Codex turn reader adds the `client_id` of
   the turn's `item_completed` user items to its inputs; `deliveryKeys` reads both. Tests on
   real rollout shapes: a queued send that runs later gives its todo; two queued sends that run
   in two turns each give their own; a `codex queue` fallback send has none; a user item without
   `client_id` adds nothing.
   Estimate: 4 files, 50 lines, 100 test lines.
4. **Kind and estimate.** Core kinds, the checks on the two operations, the fact, the Neo tool
   text, and the estimate line in `AGENTS.md` for designs. Tests: missing or unknown kind is
   refused; a pack's kind is accepted only while the pack is on; changing an estimate after
   the todo is added is refused; a daemon-made todo without one is accepted; a todo with
   a kind matches the saved rules of that kind, and one without keeps today's fallbacks.
   Estimate: 8 files, 130 lines, 150 test lines.
5. **Turn usage, Codex, and the column.** Migration and `usage` on `WorkTurnFact`. Tests on real
   rollout shapes: cached input is not counted twice; a turn read in two parts has one total;
   an old row has no usage.
   Estimate: 6 files, 130 lines, 170 test lines.
6. **Turn usage, Claude and HyperNeo.** Tests: several rows of one message count once; a
   subagent turn is incomplete; another model in the same turn is kept apart.
   Estimate: 4 files, 110 lines, 180 test lines.
7. **Size and rework.** The hook and coding's implementation. Tests: test and document paths,
   lock files, more files than one page, a hand merge, a head counted once, a todo with two
   PRs.
   Estimate: 6 files, 150 lines, 200 test lines.
8. **The read operation.** Tests: a failed todo, a todo with two workers, a missing pack hook,
   an unattributed turn in a worker the todo reached makes its usage incomplete, one in another
   worker does not; the share with no todo per adapter.
   Estimate: 4 files, 130 lines, 170 test lines.

**Done when**, one week after the last PR: at least 95% of finished todos that had a worker of
Claude Code, Claude Desktop, HyperNeo or Codex Desktop have kind and an estimate when required
(or the reviewed PR's size for a review); at least 95% have complete usage. Turns with omitted
subagent cost count as incomplete, not zero. Receipts: at least 95% of confirmed sends and
starts on the adapters that return a receipt (Claude Code, Claude Desktop, HyperNeo, Codex
Desktop), leaving out the stated limits (Claude Desktop relay sends without an input id, Codex
steers, `codex queue` fallback sends), have a receipt. Queued and unconfirmed Codex sends are on their own line: the share that got a
receipt once their message ran. Keys: at least 95% of all confirmed sends and starts, limits included,
have a delivery key. Each limited path is reported on its own line.
The share of worker turns with a todo is reported per adapter against today's 28%. For 20
turns with a todo, picked at random, the todo read from the worker's own transcript matches at least 19
times, with turns the human started counted apart. For 20 todos with complete usage, picked
at random, the totals match the harness's own records.

## Limits

- A turn without a receipt in a worker that two todos reached has none, even when the right
  todo is clear to a person. A Codex send through the `codex queue` fallback has no receipt.
- A turn the human starts in a worker that one todo reached counts for that todo, by the
  fallback, not by proof.
- Work Neo does in its own conversation has no todo and no account.
- A worker on another daemon is recorded by that daemon.
