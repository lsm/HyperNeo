# Pack preferences and human holds

Status: design for approval (question 087e13b7). No code until the human approves it.

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

## Pack preferences (core)

A pack declares its preferences next to its other hooks. A new optional field goes on `NeoPack` (`packages/daemon/src/lib/neo/packs/types.ts:60`):

```ts
preferences?: Record<string, {
  scope: 'global' | 'repo' | 'project';
  schema: z.ZodType;          // validates stored and incoming values
  default: unknown;           // used only after the human chose "use the default"
  question: string;           // what Neo asks on first use in a scope
}>;
```

The core stores and serves values. It knows nothing about any pack's meaning. Lookup order: the exact scope, then `global` for that pack. A missing value counts as **unanswered**, not as the default.

| Pack | Example preferences |
|---|---|
| Coding | per repo: merge policy and human sign-off; see below |
| Live admin | global or per project, for example whether Neo may restart a daemon without asking |
| Future packs | declare their own; nothing in the core changes |

## Coding pack preferences (scope: repo)

| Key | Values | Meaning |
|---|---|---|
| `mergePolicy` | `review_bot` with a `bot` login, `ci_only`, or `human` | `review_bot`: the bot's approval of the exact head plus green CI. `ci_only`: green CI with no review. `human`: the human reviews and merges or says so. |
| `humanSignoff` | path globs plus labels, for example `docs/design/**`, `docs/architecture/**`, label `needs-human` | A PR that touches a matching path or carries a matching label is held for the human whatever the merge policy. |

**Where paths and labels come from.** The ledger's GraphQL read (`CODING_LEDGER_QUERY`, `pr-ledger.ts:101-115`) fetches neither today.

- **Labels:** `labels(first: 10) { nodes { name } }` is added to the open-PR fields. It's cheap, and it's read on every ledger pass.
- **Paths:** fetched only for repos whose `humanSignoff` has path globs, and only for an open PR whose head differs from the head stored with its last path list. That's one small `files(first: 100) { nodes { path } }` query per new head. It stays within the existing `CODING_LEDGER_MIN_RATE` budget check, so a low rate limit skips the read and the PR stays held until paths are known. The list is stored on the ledger row (`paths_json`, `paths_head`). A PR with more than 100 files counts as matching, so it's held.

Auto-merge is not a preference: it is **never** allowed. The sweep and workers merge by hand only, and nothing in this design can enable GitHub auto-merge.

With a policy, `codingPrState` gains a policy-aware ready state. `approved_green` means "ready under this repo's policy", which differs by policy:

- **`review_bot`:** the named bot approved the exact head, and CI is green.
- **`ci_only`:** green CI is enough.
- **`human`:** the PR is never `approved_green`.

A PR the policy doesn't yet allow to merge shows `waiting_human`, and the sweep never says "merge".

## First use and seeding

**First use.** The first time the coding pack acts in a repo that has no stored `mergePolicy`, Neo asks the human one choice question. The options are the three policies, with the repo's apparent current practice shown first, and the answer is stored. Until it's answered the repo is treated as `human`: no merge nudges for that repo. One question per scope, never repeated once answered.

**Seeding.** A one-time seed writes today's practice (`set_by = 'seed'`), so these repos never ask:

| Repo | Merge policy | Human sign-off |
|---|---|---|
| lsm/HyperNeo | `review_bot`, bot hyperneo-ai-test | `docs/design/**`, `docs/architecture/**` |
| lsm/qlark | `review_bot`, bot hyperneo-ai-test | `docs/design/**`, `docs/plan/**` |
| lsm/research | `ci_only` | none |
| lsm/ops | `ci_only` | none |

## Per-PR human hold

A hold is an explicit "waiting on the human" mark: `pack_coding_pr_holds(repo, number, question_id, reason, since)`.

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
- **Yes:** the hold is removed, and the normal policy decides readiness. A `review_bot` repo still needs the bot's approval of the then-current head.
- **No, or a reply:** the hold stays, and the answer goes to the owner as a change request.
- **Retired question:** keeps the hold and asks again.

A new head commit does not lift a hold.

The question-answer path gets a generic pack hook, `onQuestionAnswered(question)` (core, no PR knowledge). The coding pack uses it to look up holds by `question_id`.

## Storage, surface, UI

**Storage.** Core table `neo_pack_preferences(pack, scope_kind, scope_key, key, value_json, set_by, set_at, PRIMARY KEY(pack, scope_kind, scope_key, key))`, a numbered migration that takes the next free number after the newest on dev and in open PRs. Holds live in the coding pack's own schema (`packs/coding/schema/coding-tables.ts`, `CREATE TABLE IF NOT EXISTS`).

**Operations** (ADR 0006, declared in `operation-names.ts`):

| Operation | Who may call it |
|---|---|
| `pack.preferences.list`, `pack.preferences.get` | Read-only; anyone. |
| `pack.preferences.set` | `safetyClass: 'human_only'`, like `neo.preferences.set` (`model-preference.ts:115`). It validates against the pack's schema and records `set_by`. |
| `pack.coding.pr.hold` | Any agent; holding only adds safety. |
| `pack.coding.pr.release` | `human_only`. |

Without that restriction an agent could loosen its own repo's policy or clear `humanSignoff`, recreating the failure this design prevents. Two values are written outside the operation: the first-use answer, through the human's answer to Neo's question, and the one-time seed, from the migration. Neo and workers can't change a preference or lift a hold themselves. A hold also lifts automatically when the human answers its linked question.

**UI.** Web gets a "Packs" settings panel listing each pack, its scopes (repos for coding) and current values, with edit controls that call the same operations. iOS reads and edits through the same operations. That UI lives in the private neo-ios repo; this doc defines only the contract.

## Tests (what a user can observe)

- **Each policy:** a repo with that policy gets the right nudges for an approved, green PR. `review_bot` and `ci_only` get "merge"; `human` gets none.
- **Sign-off match:** a PR matching `humanSignoff` in a `review_bot` repo shows `waiting_human`, the owner gets no merge text, and the snapshot shows the hold.
- **Lifting:** answering the linked question "yes" lifts the hold and allows the merge nudge; "no" keeps it and tells the owner.
- **First use:** one question per new repo, none after it's answered, and no merge nudges before the answer.
- **qlark#19 replay:** reproduced first. Same timeline with `docs/design/**` held: no merge nudge at +20 min.

## Slices (each about 100–200 production lines, built from fresh dev; Build and Wire kept apart per ADR 0004)

1. **Build core preferences.** `NeoPack.preferences` type, the `neo_pack_preferences` migration, repository and lookup.
2. **Build the operations.** `pack.preferences.*` with `set` human-only, plus the one-time seed for the four repos.
3. **Build PR labels and paths.** Labels in the ledger query; the per-new-head paths read under the rate budget; `paths_json` and `paths_head` on the ledger row.
4. **Wire policy-aware ledger state** and `waiting_human`. The qlark#19 replay test is committed failing first.
5. **Build holds.** The table, plus `pack.coding.pr.hold` and the human-only `pack.coding.pr.release`; nothing reads them yet.
6. **Wire holds into the sweep and events.** Held PRs get no merge text and no reminders, and the owner is told once.
7. **Build the `onQuestionAnswered` core hook.** Nothing calls it yet.
8. **Wire question-linked holds.** Hold creation opens the linked question, and the hook lifts or keeps the hold.
9. **Wire the first-use question** for repos with no stored policy, written through the human's answer.
10. **Web Packs panel**, with the verify-skill journey added in the same PR.
11. **Delete the merge-rule text** from `packs/coding/instructions.md:18-27`, once the daemon enforces it.
