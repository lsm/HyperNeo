# Pack settings, conventions and human holds

Status: design for approval (question 087e13b7, revised with the human). No code until the human approves it.

## Problem

Today's merge rules live only in prompt text.

- The coding pack's Neo instructions (`packages/prompts/src/neo/packs/coding/instructions.md:18-20`) say to put "the repository's merge rule in a coding todo's instruction: merge by hand after the review it uses approves the latest head and required checks are green, and never enable GitHub auto-merge."
- Lines 21-27 say to ask the human once how a new repository's pull requests get reviewed and to "write the answer into that repository's merge rule". The answer goes only into later todo text; nothing stores it.

The daemon doesn't know any of these rules. The coding pack's PR sweep tells an owner to merge any PR that GitHub shows as approved and green, even when the human still has to sign off.

**Incident, lsm/qlark#19** (a design doc that needed the human's approval):

| Time (UTC, 2026-10-20) | Event |
|---|---|
| 16:42:48 | The human comments on the PR. |
| 16:45:51 | hyperneo-ai-test approves the head. |
| 17:07:26 | The PR is merged, about 20 minutes later. |

That 20 minutes is exactly the sweep's `approved_green` deadline. The first wrong decision is the state derivation; the two nudges act on it:

- `packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts:139-140`. `codingPrState` returns `approved_green` from GitHub facts alone: the last review on the head is APPROVED and CI is green or absent. Nothing says whose approval the repo requires, or that the human must sign off.
- `pr-events.ts:29-31` sends the owner "is approved and green … Merge it now" the moment the state appears.
- `pr-sweep.ts:7` sets a 20-minute deadline for `approved_green`, and `pr-sweep.ts:46` repeats "Merge it now with a manual squash". The sweep (`sweepCodingPrs`, `pr-sweep.ts:113-137`) has no notion of a PR held for the human.

## Two kinds of thing

1. **Settings** are structured and enforced by code. A pack declares typed values in code, and the daemon acts on them directly. For coding they are `mergePolicy` and `humanSignoff`. The first-use question is only how a value gets collected.
2. **Conventions** are open and meant for agents. A convention is a rule the settings don't cover, in the human's own words, scoped to global, a pack, or a pack plus an object. Code doesn't enforce them; they're added to the instruction of matching work.

Growth path: a convention that keeps mattering and can be checked in code is turned into a setting by a developer. There are no user-defined setting fields, no settings UI panel, and no generic question engine.

## Settings (core)

A pack declares its settings next to its other hooks, as a new optional field on `NeoPack` (`packages/daemon/src/lib/neo/pack-contract.ts`):

```ts
preferences?: Record<string, {
  scope: 'global' | 'repo' | 'project';
  type:                        // closed set; no free-form fields
    | { kind: 'enum'; values: readonly string[] }
    | { kind: 'boolean' }
    | { kind: 'number'; min?: number; max?: number }
    | { kind: 'globs' }
    | { kind: 'login' };       // a GitHub login, checked against GitHub's login rules
  default: unknown;            // offered first in the question; never applied silently
  ask: string;                 // one-line wording for the first-use question
}>;
```

The core stores and serves values, and knows nothing about any pack's meaning. Lookup order: the exact scope, then `global` for that pack. A missing value counts as **unanswered**, not as the default. The coding pack's explicit pre-answer `sessionStrategy` behavior below is a runtime fallback; it does not store a default or mark the question answered.

The first-use question is **generated from the declaration** and sent through the existing `neo.question.ask`. An enum becomes a choice question, a boolean a yes/no question, and globs, numbers and logins a reply question validated against the type. A setting may declare `askWhen: { key, equals }` so it's asked only when another setting has a given value. There is no separate question system.

## Coding settings (scope: repo)

| Key | Values | Meaning |
|---|---|---|
| `mergePolicy` | enum: `review_bot`, `ci_only` or `human` | `review_bot`: the review bot's approval of the exact head plus green CI. `ci_only`: green CI with no review. `human`: the human reviews and merges or says so. |
| `reviewBot` | `login`, asked only when `mergePolicy` is `review_bot` | The bot whose approval counts, for example `hyperneo-ai-test`. A `review_bot` repo with no `reviewBot` counts as `human` until it's answered. |
| `humanSignoff` | `globs`: path globs, plus `label:<name>` entries for labels, for example `docs/design/**`, `docs/architecture/**`, `label:needs-human` | A PR that touches a matching path or carries a matching label is held for the human whatever the merge policy. |
| `sessionStrategy` | enum: `long_lived` (default), `per_task`, `per_pr` | How Neo reuses or creates sessions on dispatch; before an answer it uses `long_lived` without storing it. See Session strategy. |

**Where paths and labels come from.** The ledger's GraphQL read (`CODING_LEDGER_QUERY`, `pr-ledger-source.ts`) fetches neither today.

- **Review authors:** the reviews fetch (`FIELDS`, `pr-ledger-source.ts`) gains `author { login }`. Its nodes carry only `state` and `commit { oid }` today, and `reviewDecision` doesn't say who approved, so without the login a `review_bot` repo can't tell the bot's approval from anyone else's.
- **Labels:** `labels(first: 100) { pageInfo { hasNextPage } nodes { name } }` is added to the open-PR fields and read on every ledger pass. A truncated label page counts as matching, so the PR is held, the same as the paths case below.
- **Paths:** fetched only for repos whose `humanSignoff` has path globs, and only for an open PR whose head differs from the head stored with its last path list. That's one small `files(first: 100) { nodes { path } }` query per new head. It stays within the existing `CODING_LEDGER_MIN_RATE` budget check, so a low rate limit skips the read and the PR stays held until paths are known. The list is stored on the ledger row (`paths_json`, `paths_head`). A PR with more than 100 files counts as matching, so it's held.

Auto-merge is not a preference: it is **never** allowed. The sweep and workers merge by hand only, and nothing in this design can enable GitHub auto-merge.

With a policy, `codingPrState` maps GitHub facts to states per policy. `failing`, `changes_requested`, `dirty`, `draft`, `merged` and `closed` are unchanged under every policy, and so are their fix-it nudges. Only the states that lead to a merge change:

| GitHub facts on the head (no failure, no changes requested) | `review_bot` | `ci_only` | `human` |
|---|---|---|---|
| No approval from `reviewBot`, CI pending or green | `waiting_review`; the "re-request the review bot" nudge stays | CI pending: `waiting_ci`. CI green: `approved_green` | CI pending: `waiting_ci`. CI green: `waiting_human` |
| Only someone other than `reviewBot` approved, for example the human | `waiting_review` | as above | as above |
| `reviewBot` approved, CI pending | `approved_pending` | as above | as above |
| `reviewBot` approved, CI green | `approved_green` | as above | `waiting_human` |
| The human approved this head (a hold row's `approved_head` covers it, see Approval scope), CI green | per the `review_bot` rows | `approved_green` | `approved_green` |

**No CI.** A repo with no CI keeps today's rule (`pr-ledger.ts:133,140`): a head with no status rollup and no check suites counts as "CI green" in every column, so a `ci_only` repo without CI is ready as soon as nothing failed.

**`unreviewed` goes away.** Today `codingPrState` guesses a repo has no review from its PR history (`repoHasReview`, `pr-ledger.ts:141`) and returns `unreviewed`. A stored `mergePolicy` replaces that guess, so `unreviewed` folds into the table's "no approval from `reviewBot`" row:
- `review_bot`: `waiting_review`;
- `ci_only`: `waiting_ci`, then `approved_green`;
- `human`: `waiting_ci`, then `waiting_human`.

The "green CI again" event (`pr-events.ts:33-37`, `from === 'failing'` into `waiting_review` or `unreviewed`) becomes `from === 'failing'` into `waiting_review`, `waiting_ci` or `waiting_human`, with the same text. A PR going from `failing` straight to `approved_green` gets the `approved_green` event instead, as today.

In a `human` repo the human's approval is the review: once a hold row's `approved_head` covers the current head and CI is green, the PR is `approved_green` and gets the normal merge nudge. Before that it's `waiting_human`.

A **hold** overrides only merge readiness, under every policy: a held PR that would be `approved_green` or `approved_pending` shows `waiting_human` instead. Every other state stays as it is, so the owner still fixes failing CI, conflicts and review findings on a held PR.

**Wording rule.** Merge text appears only for `approved_green`:
- `pr-sweep.ts:46`'s "Merge it now".
- The escalation clause "or merge it yourself if it is approved and green" (`pr-sweep.ts:85`) is added only when the row is `approved_green`.
- `approved_pending`'s next step loses "merge once CI is green" (`pr-sweep.ts:52`) and says only that CI is still running.
- `waiting_ci` is new, with its own wording: "CI is still running; fix it if it fails". It gets a 60-minute entry in `CODING_PR_DEADLINE_MIN` (`pr-sweep.ts:6-13`), the same as `approved_pending`, because deadline-gated nudges are the only channel that delivers state wording. It never mentions merging, under any policy.
- `waiting_human` gets no merge text and no deadline.

## Session strategy

Approved by the human in question `9bec1d4c-bf30-44d6-84c1-d179fcd0c572`
(`yes`, "加进设计，默认长周期"). This is a repo-scoped coding setting,
independent of merge policy; selecting a session never grants permission to merge.

| Value | Dispatch behavior | Session lifetime |
|---|---|---|
| `long_lived` (default) | Reuse sessions named for work type: frontend, backend, iOS, or dev-1/2/3, never task titles. All PRs of one feature go to the same session. | Keep the session available for later work after a feature finishes. |
| `per_task` | Start one session for each task; that task's follow-ups and PRs stay there. | Retire its assignment when the task is done. |
| `per_pr` | Start one session for each PR; review fixes and CI fixes return to that PR's session. This offers the most parallelism and the highest token cost. | Retire its assignment when that PR's work is done. |

**First dispatch.** When a repo has no stored `sessionStrategy`, Neo asks one
choice question generated from its declaration, offering `long_lived` first.
Repeated dispatches reuse the same open question. While unanswered, dispatch
uses `long_lived`; it neither writes a preference nor claims the human answered.
A human answer persists through the settings-question answer path. Later human
changes use the same human-only settings rules. A strategy change affects future
assignments, never moves a task already running or splits its active PR ownership.

**Sources for "busy" and "related".** These are dispatch facts, not guesses from
session titles, transcript similarity, or command lines:

- The repo comes from the coding todo's resolved repository and workspace.
  Candidates are existing, reusable sessions for that repo on a reachable driver
  that supports continuing the work. A work-type name is descriptive, not a repo
  identity or a reason to ignore an idle compatible session.
- Busy comes from a fresh `work.status`/driver summary (`WorkSummarySchema.busy`,
  `queued` or `running`) plus durable ownership in `neo_todos` and
  `neo_todo_sessions`. A session with unfinished work remains occupied even if
  its turn is idle while CI or review runs. `needs_you` also reserves it for its
  current work; Neo doesn't steer around the human's prompt. A stale/unreachable
  status is unknown, not evidence of an idle session or permission to create one.
- Related comes from a durable repo + `featureKey` assignment to a `WorkRef`.
  A todo uses its ask id as the default feature key; when several asks implement
  one feature, Neo links them to one explicit shared key before dispatch. Existing
  todo/session and PR-claim bindings attach later PRs and review work to that same
  feature. Repo equality alone doesn't make two features related. Neo may choose
  a work type from the task's intended role, but may not replace the stored
  feature key with a title-based guess each time it dispatches.

**`long_lived` decision order.** Look up the feature assignment first. If it has
an available session, send there (`target.verb = 'send'` / `work.send`); if it is
busy, queue the related work for that same session. Never create another session
for the feature just to bypass its current PR or review. Without an assignment,
reuse an idle compatible session in the repo pool, preferring its work type, and
bind the feature to it. Only when every existing compatible session is busy and
the new work is unrelated to all their assignments may Neo create a new session
(`target.verb = 'start'` / `work.start`). An empty pool bootstraps its first
session. If inventory or status is unknown, refresh or wait. Concurrent dispatches
reserve the feature/session assignment before calling the driver so two todos
cannot both decide to start its session; retries recover that reservation rather
than starting a duplicate. `work.start` receives the work-type session name while
the todo retains its own task title.

The binding is consulted in `todo-runner.ts` before its existing dispatch, which
currently accepts a start/send target and forwards it through `driver-work.ts`.
The daemon validates the selected target against the plan; an agent-supplied
`start` cannot silently bypass reuse. `per_task` keys the assignment by todo id;
`per_pr` uses the known PR identity, or a reserved prospective-PR slot until that
session reports its PR. Retries reuse the slot; reporting the URL binds it without
starting again. A known PR already owned by a session keeps that owner. Separate
PR slots may run in parallel, subject to ordinary capacity and workspace rules.
Retiring an assignment means stopping future dispatch to that task/PR session,
not deleting a session, transcript, stored result, or worktree history. A failed
or human-blocked task keeps its ownership until it is settled or explicitly
reassigned; it isn't silently treated as finished.

## First use and existing repos

**First use.** The first time the coding pack acts in a repo with no stored `mergePolicy`, Neo asks the generated question once, with the repo's apparent current practice offered first, and stores the answer. Until it's answered the repo is treated as `human`: no merge nudges there. Once answered, it's never asked again. This replaces the prompt-only question in `instructions.md:21-27`.

**This install's existing repos.** Values aren't seeded by a schema migration, because migrations run on every HyperNeo install and these are one person's repos. Instead, after slice 2 ships, Neo proposes today's practice for the repos this install already tracks in one question to the human. The answer writes them through `pack.preferences.set` on the human's turn (`set_by = 'human'`). For this install the proposal is:

| Repo | Merge policy | Human sign-off |
|---|---|---|
| lsm/HyperNeo | `review_bot`, `reviewBot` hyperneo-ai-test | `docs/design/**`, `docs/architecture/**` |
| lsm/qlark | `review_bot`, `reviewBot` hyperneo-ai-test | `docs/design/**`, `docs/plan/**` |
| lsm/research | `ci_only` | none |
| lsm/ops | `ci_only` | none |

## Per-PR human hold

A hold is an explicit "waiting on the human" mark: `pack_coding_pr_holds(repo, number, question_id, reason, since, approved_head)`. The row is kept after the human answers; `approved_head` records which head the human approved.

**Created when** one of these happens:
- a PR matches `humanSignoff`, judged on its labels and the path list for its current head;
- the repo's stored policy is `human`. A repo that has no answer yet gets no per-PR holds or questions. It shows `waiting_human`, gets no merge nudges, and gets only the one first-use policy question (slice 11). Before slice 11 lands, a repo the human hasn't answered for, in slice 2's question or later, just stays `waiting_human`.
- Neo or a worker holds it through an operation, for example a design doc awaiting approval.

A hold's linked Neo question (`neo_questions`, `m387-neo-ask-todo-tables.ts:81`) opens only when the PR is otherwise ready to merge: not a draft, nothing failing, no conflict, no requested changes, CI green, and in a `review_bot` repo, approved by `reviewBot`. It names the PR and the head as a yes/no question: "Approve lsm/qlark#19 at 9f88dc9 for merge?" A held PR that isn't ready yet shows its normal fix-it state and asks nothing.

**Effect.** While held:
- would-be merge-ready states (`approved_green`, `approved_pending`) become `waiting_human`, as in the state table; fix-it states (`failing`, `changes_requested`, `dirty`, `waiting_review`, `waiting_ci`) keep their own nudges, which never mention merging;
- `planCodingPrEvent` and the sweep send no "merge" text, and `waiting_human` has no deadline reminders;
- the snapshot shows the PR as held, with the question;
- the owner is told once: "waiting on the human; don't merge".

**Lifted automatically** when the linked question is answered:
- **Yes:** the row's `approved_head` is set to the head the question named, and the hold stops applying to the PR; the normal policy decides readiness. Automatic holding (`humanSignoff`, a `human` policy) checks for that row first, so it never re-holds an approved PR or re-asks. A `review_bot` repo still needs the bot's approval of that head.
- **No, or a reply:** the hold stays, and the answer goes to the owner as a change request.
- **Retired question:** keeps the hold and asks again.

**Approval scope: `whole_pr`** (the human's answer to question a0814e6f): an approval covers the PR from `approved_head` on. Later heads stay approved and Neo doesn't ask again for that PR; they need only the repo's policy (in a `review_bot` repo, the bot's approval of the new head and green CI). A new `humanSignoff` match on a later head doesn't re-hold it either. A new head never lifts an unapproved hold on its own. `pack.coding.pr.release` (human only) sets `approved_head` the same way as a "yes".

## Worker merge check

Suppressing nudge text isn't enough: the worker merges by itself. Whenever a todo's `doneWhen` mentions merging, `driver-work.ts:83-88` appends `goal-merge.md` (`NEO_WORK_GOAL_MERGE`) to the worker's instruction on every delivery. That text tells the worker to judge readiness itself, from "the repository's own ready signal" or from how recent PRs were merged, and then run `gh pr merge --squash`. It knows nothing of `mergePolicy` or holds. Today it defers to the per-todo merge rule Neo writes (`instructions.md:18-20`); once slice 14 deletes that, the guesswork would decide, and a held `docs/design/**` PR in qlark would merge on bot approval and green CI, which is the qlark#19 incident.

So the daemon's state becomes the worker's ready signal:
- **`pack.coding.pr.readiness`** (read-only, any caller) takes `{ repo, number }` and returns the ledger state for the PR's current head, any hold with its question, and `mayMerge`: true only for `approved_green`. It re-reads the PR the same way the sweep does, so a worker never acts on a stale row.
- **`goal-merge.md`** is rewritten around it: call `pack.coding.pr.readiness` immediately before merging, and run `gh pr merge <number> --squash` only when it returns `mayMerge` for the head you are about to merge. Otherwise report its state and wait for the PR event. The "own ready signal" and recent-merge archaeology go, because a repo with no stored policy is `waiting_human` and never merge-ready.

The worker runs `gh` with the human's GitHub access, so the daemon can't refuse the merge itself; the instruction and the daemon state are the guard, and the sweep's "held, don't merge" tell repeats the same answer. The rest of `goal-merge.md` (no auto-merge, resolve threads, merge as its own command, diagnose a refused merge) stays.

The question-answer path gets a generic pack hook, `onQuestionAnswered(question)` (core, no PR knowledge). The coding pack uses it to look up holds by `question_id`.

## Storage and operations

**Storage.** Core table `neo_pack_preferences(pack, scope_kind, scope_key, key, value_json, set_by, set_at, PRIMARY KEY(pack, scope_kind, scope_key, key))`, a numbered migration that takes the next free number after the newest on dev and in open PRs. Holds live in the coding pack's own schema (`packs/coding/schema/coding-tables.ts`, `CREATE TABLE IF NOT EXISTS`).

**Operations** (ADR 0006, declared in `operation-names.ts`):

| Operation | Who may call it |
|---|---|
| `pack.preferences.list`, `pack.preferences.get` | Read-only; anyone. Values also appear in `neo.snapshot`, so the human sees them through Neo. |
| `pack.preferences.set` | `safetyClass: 'human_only'`, like `neo.preferences.set` (`model-preference.ts:115`). It validates against the declared type and records `set_by`. |
| `pack.coding.pr.hold` | Any agent; holding only adds safety. |
| `pack.coding.pr.release` | `human_only`. |

Without that restriction an agent could loosen its own repo's policy or clear `humanSignoff`, recreating the failure this design prevents. One value is written outside the operation: the first-use answer, through the human's answer to the generated question. This install's existing repos go through the operation itself, on the human's turn. Neo and workers can't change a setting or lift a hold themselves. A hold also lifts automatically when the human answers its linked question. There's no settings panel: the human changes a setting by telling Neo, which asks the question or calls `set` on the human's turn.

## Conventions

A convention is built on the existing `neo.rule.save` (`packages/daemon/src/lib/neo/operations.ts:499-535`), not as a new mechanism.

**What stays the same.** It's still admitted only on the human's own turn (`operations.ts:292`) and still requires a `from` quote of the human's exact words (`requireNeoRuleCitation`). Today a rule is a plain string in global settings (`neo.standingRules`).

**What's added:**

- **Scope.** The input gains an optional scope `{ pack?, object? }`, for example `{ pack: 'coding' }` or `{ pack: 'coding', object: 'lsm/research' }`. A stored rule becomes `{ text, pack?, object? }`; existing string rules read as global. The 20-rule and 500-character limits apply per scope.
- **Delivery.** When Neo hands out work, `neoTodoCard` (`packages/daemon/src/lib/neo/todo-runner.ts:69-77`), which already joins the todo instruction with the pack's `workerRules`, also appends the conventions matching that work. A pack names the object a todo belongs to through a small hook, `conventionObject(todo)`; for coding that's the todo's repo. Global conventions stay in Neo's own snapshot, as today.
- **Origin.** Conventions come only from the human's words; agents never write them.

## Tests (what a user can observe)

- **Each policy:** a repo with that policy gets the right nudges for an approved, green PR. `review_bot` and `ci_only` get "merge"; `human` gets none until the human approves the PR, then gets "merge".
- **Sign-off match:** a PR matching `humanSignoff` in a `review_bot` repo shows `waiting_human`, the owner gets no merge text, and the snapshot shows the hold.
- **Lifting:** answering the linked question "yes" lifts the hold and allows the merge nudge, and it stays lifted on later sweeps and later heads, with no new question; a later head in a `review_bot` repo still waits for the bot's approval of that head. "No" keeps the hold and tells the owner.
- **First use:** one question per new repo, none after it's answered, and no merge nudges before the answer.
- **Conventions:** a convention saved for `coding` + `lsm/research` appears in the instruction of a coding todo for lsm/research, not in one for lsm/qlark. A save without the human's quoted words is refused.
- **Session strategy:** an unanswered repo gets one question and behaves as `long_lived` without a stored default. Two PR slices of a feature reuse one work-type-named session; related work queues while it is busy. An unrelated task uses an idle session before any start; only an all-busy unrelated pool permits a new one. Stale status and concurrent dispatch never produce a duplicate feature session. `per_task` reuses within its task; `per_pr` reuses each PR/slot through retries and review, with distinct PRs parallel. Retiring assignments preserves stored data; changing strategy doesn't move active work.
- **qlark#19 replay:** reproduced first. Same timeline with `docs/design/**` held: no merge nudge at +20 min, and `pack.coding.pr.readiness` returns `mayMerge: false` with the hold.
- **Worker merge check:** a coding todo whose `doneWhen` mentions merging gets the rewritten merge text, with no recent-merge fallback; `pack.coding.pr.readiness` returns `mayMerge` true only for `approved_green`, and false for a held, unanswered-repo or `human`-policy PR before approval.

## Slices (each about 100–200 production lines, built from fresh dev; Build and Wire kept apart per ADR 0004)

The qlark#19 prevention comes first: stored settings and this install's answers (1–2), policy-aware readiness (3), then holds (4–6), then the worker's own merge check (7–8), then lifting a hold when the human answers (9–10).

1. **Build core settings.** `NeoPack.preferences` declaration type, the `neo_pack_preferences` migration (schema only, no rows) and lookup.
2. **Build the settings operations** (`pack.preferences.*`, `set` human-only), with the values in `neo.snapshot`. Neo then proposes this install's existing repos to the human in one question.
3. **Wire policy-aware ledger state** per the state table, including `waiting_human` and `waiting_ci`. The qlark#19 replay test is committed failing first. Repos without a stored policy count as `human`.
4. **Build PR review authors, labels and paths.** Review-author logins and labels in the ledger query; the per-new-head paths read under the rate budget; `paths_json` and `paths_head` on the ledger row.
5. **Build holds.** The table, plus `pack.coding.pr.hold` and the human-only `pack.coding.pr.release`; nothing reads them yet.
6. **Wire holds into the sweep and events**, including automatic holds from `humanSignoff`. Held PRs get no merge text and no reminders, and the owner is told once.
7. **Build `pack.coding.pr.readiness`.** Read-only operation over the ledger state and holds; nothing in the prompts names it yet.
8. **Wire the worker merge check:** rewrite `goal-merge.md` to merge only on `mayMerge`, removing the ready-signal and recent-merge fallback.
9. **Build the `onQuestionAnswered` core hook.** Nothing calls it yet.
10. **Wire question-linked holds.** Hold creation opens the linked question, and the human's answer lifts or keeps the hold.
11. **Wire the generated first-use question** for repos with no stored policy.
12. **Build scoped conventions** in `neo.rule.save`: the scope input and storage; nothing delivers them yet.
13. **Wire convention delivery** into `neoTodoCard` through the `conventionObject(todo)` hook.
14. **Delete the merge-rule prompt text** from `packages/prompts/src/neo/packs/coding/instructions.md`, only after slices 6, 8 and 11 have landed, so the worker's merge path already reads the daemon state and the generated first-use question has replaced the prompt's. Only these sentences go:
    - "Put the repository's merge rule in a coding todo's instruction: merge by hand after the review it uses approves the latest head and required checks are green, and never enable GitHub auto-merge." (lines 18-20)
    - "When you create a repository, or first start coding work in one with no merged pull request yet, ask the human once with neo.question.ask (kind choice) how its pull requests get reviewed: … \"I review them myself\"." (lines 21-24, ending mid-line 24)
    - "Write the answer into that repository's merge rule; until they answer, nothing there merges." (starting at the end of line 25, through line 27)

    The edits go sentence by sentence; line ranges are only locators, because lines 24 and 25 are shared. The sentence "Never install apps, add reviewers or change repository settings yourself; that is the human's own GitHub setup." stays whole. The Claude Desktop question that follows ("in the same round of questions", lines 28-29) is reworded to stand alone.


**Persistence prerequisite ([#7892](https://github.com/lsm/HyperNeo/issues/7892),
scheduled immediately after slice 3).** `pack.preferences.ask` takes an ask id,
a retry request id and typed setting values. It validates them, generates the
question text showing the exact values, and atomically stores the question with
its immutable proposal. The human's yes applies only those stored values through
the trusted question-answer path; `pack.preferences.applyAnswer` retries by
question id only, accepting no caller-supplied replacement values. Agent setters
stay forbidden. This is forward-only: an old question without a bound proposal
cannot authorize settings. Slice 11's generated settings questions and slice 18's
strategy question use this same persistence path.

Session-strategy extension (after #7892 and existing dispatch prerequisites;
these do not gate the merge-safety slices above):

15. **Build the session strategy declaration and pure dispatch planner.** Declare
    the repo enum and explicit pre-answer `long_lived` behavior. Plan reuse, queue
    or start from typed pool/status/assignment facts; nothing dispatches it yet.
16. **Build durable session assignments.** Store repo/feature/task/PR-slot to
    session ownership with atomic reservation and retry recovery. Integrate the
    existing todo/session and PR bindings; nothing chooses a driver target yet.
17. **Wire session strategy into coding dispatch.** Validate start/send against
    the planner before `todo-runner` invokes the driver, give new long-lived
    sessions work-type names, and settle assignments without deleting history.
18. **Wire the first-dispatch strategy question.** Generate the one-per-repo
    question and bind its typed proposal through the #7892 persistence path above. Prove
    pending-answer `long_lived` behavior and subsequent dispatch using the saved
    choice. No agent setter rights are added.
