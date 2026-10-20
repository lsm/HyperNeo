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

A pack declares its settings next to its other hooks, as a new optional field on `NeoPack` (`packages/daemon/src/lib/neo/packs/types.ts:60`):

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

The core stores and serves values, and knows nothing about any pack's meaning. Lookup order: the exact scope, then `global` for that pack. A missing value counts as **unanswered**, not as the default.

The first-use question is **generated from the declaration** and sent through the existing `neo.question.ask`. An enum becomes a choice question, a boolean a yes/no question, and globs, numbers and logins a reply question validated against the type. A setting may declare `askWhen: { key, equals }` so it's asked only when another setting has a given value. There is no separate question system.

## Coding settings (scope: repo)

| Key | Values | Meaning |
|---|---|---|
| `mergePolicy` | enum: `review_bot`, `ci_only` or `human` | `review_bot`: the review bot's approval of the exact head plus green CI. `ci_only`: green CI with no review. `human`: the human reviews and merges or says so. |
| `reviewBot` | `login`, asked only when `mergePolicy` is `review_bot` | The bot whose approval counts, for example `hyperneo-ai-test`. A `review_bot` repo with no `reviewBot` counts as `human` until it's answered. |
| `humanSignoff` | `globs`: path globs, plus `label:<name>` entries for labels, for example `docs/design/**`, `docs/architecture/**`, `label:needs-human` | A PR that touches a matching path or carries a matching label is held for the human whatever the merge policy. |

**Where paths and labels come from.** The ledger's GraphQL read (`CODING_LEDGER_QUERY`, `pr-ledger.ts:101-115`) fetches neither today.

- **Review authors:** the reviews fetch (`pr-ledger.ts:102`) gains `author { login }`. Its nodes carry only `state` and `commit { oid }` today, and `reviewDecision` doesn't say who approved, so without the login a `review_bot` repo can't tell the bot's approval from anyone else's.
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

A **hold** overrides only merge readiness, under every policy: a held PR that would be `approved_green` or `approved_pending` shows `waiting_human` instead. Every other state stays as it is, so the owner still fixes failing CI, conflicts and review findings on a held PR. The sweep says "merge" only for `approved_green`; `waiting_human` gets no merge text and no deadline. `waiting_ci` is new; it has the existing approved-pending wording without "approved".

## First use and seeding

**First use.** The first time the coding pack acts in a repo with no stored `mergePolicy`, Neo asks the generated question once, with the repo's apparent current practice offered first, and stores the answer. Until it's answered the repo is treated as `human`: no merge nudges there. Once answered, it's never asked again. This replaces the prompt-only question in `instructions.md:21-27`.

**Seeding.** A one-time seed writes today's practice (`set_by = 'seed'`), so these repos never ask:

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
- the repo's policy is `human`;
- Neo or a worker holds it through an operation, for example a design doc awaiting approval.

Creating a hold also opens one linked Neo question (`neo_questions`, `m387-neo-ask-todo-tables.ts:81`) that names the PR. It's a yes/no question: "Approve lsm/qlark#19 for merge?"

**Effect.** While held:
- the ledger state is `waiting_human`;
- `planCodingPrEvent` and the sweep send no "merge" text and no deadline reminders;
- the snapshot shows the PR as held, with the question;
- the owner is told once: "waiting on the human; don't merge".

**Lifted automatically** when the linked question is answered:
- **Yes:** the row's `approved_head` is set to the head the question named, and the hold stops applying to that head; the normal policy decides readiness. Automatic holding (`humanSignoff`, a `human` policy) checks for that row first, so it never re-holds an approved head or re-asks. A `review_bot` repo still needs the bot's approval of that head.
- **No, or a reply:** the hold stays, and the answer goes to the owner as a change request.
- **Retired question:** keeps the hold and asks again.

Approval is per head. A head pushed after the approval is not covered: the hold applies again, and Neo asks once more, naming both heads so the human can see what changed. This is deliberate: the human approves content, and a later commit can change it. A new head never lifts a hold on its own. `pack.coding.pr.release` (human only) sets `approved_head` the same way.

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

Without that restriction an agent could loosen its own repo's policy or clear `humanSignoff`, recreating the failure this design prevents. Two values are written outside the operation: the first-use answer, through the human's answer to the generated question, and the one-time seed, from the migration. Neo and workers can't change a setting or lift a hold themselves. A hold also lifts automatically when the human answers its linked question. There's no settings panel: the human changes a setting by telling Neo, which asks the question or calls `set` on the human's turn.

## Conventions

A convention is built on the existing `neo.rule.save` (`packages/daemon/src/lib/neo/operations.ts:499-535`), not as a new mechanism.

**What stays the same.** It's still admitted only on the human's own turn (`operations.ts:292`) and still requires a `from` quote of the human's exact words (`requireNeoRuleCitation`). Today a rule is a plain string in global settings (`neo.standingRules`).

**What's added:**

- **Scope.** The input gains an optional scope `{ pack?, object? }`, for example `{ pack: 'coding' }` or `{ pack: 'coding', object: 'lsm/research' }`. A stored rule becomes `{ text, pack?, object? }`; existing string rules read as global. The 20-rule and 500-character limits apply per scope.
- **Delivery.** When Neo hands out work, `neoTodoCard` (`packages/daemon/src/lib/neo/todo-runner.ts:69-77`), which already joins the todo instruction with the pack's `workerRules`, also appends the conventions matching that work. A pack names the object a todo belongs to through a small hook, `conventionObject(todo)`; for coding that's the todo's repo. Global conventions stay in Neo's own snapshot, as today.
- **Origin.** Conventions come only from the human's words; agents never write them.

## Tests (what a user can observe)

- **Each policy:** a repo with that policy gets the right nudges for an approved, green PR. `review_bot` and `ci_only` get "merge"; `human` gets none.
- **Sign-off match:** a PR matching `humanSignoff` in a `review_bot` repo shows `waiting_human`, the owner gets no merge text, and the snapshot shows the hold.
- **Lifting:** answering the linked question "yes" lifts the hold and allows the merge nudge, and it stays lifted on later sweeps of that head. A new head re-holds and asks once. "No" keeps the hold and tells the owner.
- **First use:** one question per new repo, none after it's answered, and no merge nudges before the answer.
- **Conventions:** a convention saved for `coding` + `lsm/research` appears in the instruction of a coding todo for lsm/research, not in one for lsm/qlark. A save without the human's quoted words is refused.
- **qlark#19 replay:** reproduced first. Same timeline with `docs/design/**` held: no merge nudge at +20 min.

## Slices (each about 100–200 production lines, built from fresh dev; Build and Wire kept apart per ADR 0004)

The qlark#19 prevention, slices 1–7, comes first: policy-aware readiness, then holds, then lifting a hold when the human answers.

1. **Build core settings.** `NeoPack.preferences` declaration type, the `neo_pack_preferences` migration, lookup, and the one-time seed for the four repos.
2. **Wire policy-aware ledger state** per the state table, including `waiting_human` and `waiting_ci`. The qlark#19 replay test is committed failing first. Repos without a stored policy count as `human`.
3. **Build PR review authors, labels and paths.** Review-author logins and labels in the ledger query; the per-new-head paths read under the rate budget; `paths_json` and `paths_head` on the ledger row.
4. **Build holds.** The table, plus `pack.coding.pr.hold` and the human-only `pack.coding.pr.release`; nothing reads them yet.
5. **Wire holds into the sweep and events**, including automatic holds from `humanSignoff`. Held PRs get no merge text and no reminders, and the owner is told once.
6. **Build the `onQuestionAnswered` core hook.** Nothing calls it yet.
7. **Wire question-linked holds.** Hold creation opens the linked question, and the human's answer lifts or keeps the hold.
8. **Build the settings operations** (`pack.preferences.*`, `set` human-only), with the values in `neo.snapshot`.
9. **Wire the generated first-use question** for repos with no stored policy.
10. **Build scoped conventions** in `neo.rule.save` (scope input and storage) and **wire their delivery** into `neoTodoCard`. If it exceeds the slice budget, split Build and Wire.
11. **Delete the merge-rule prompt text** from `packages/prompts/src/neo/packs/coding/instructions.md`, once the daemon enforces it. Only these sentences go:
    - lines 18-20: put the merge rule in the todo instruction;
    - lines 21-24: the ask-once review question;
    - lines 26-27: write the answer into the merge rule.

    The sentence "Never install apps, add reviewers or change repository settings yourself; that is the human's own GitHub setup" stays. The Claude Desktop question that follows ("in the same round of questions", lines 28-29) is reworded to stand alone.
