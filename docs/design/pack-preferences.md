# Pack preferences and human holds

Status: design for approval (question 087e13b7). No code until the human approves it.

## Problem

Today's merge rules live only in the text of Neo's worker instructions, for example "squash by hand after hyperneo-ai-test approves the exact head and CI is green". The daemon doesn't know them. The coding pack's PR sweep tells an owner to merge any PR that GitHub shows as approved and green, even when the human still has to sign off.

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
- a PR matches `humanSignoff`;
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

**Operations** (ADR 0006, declared in `operation-names.ts`), all behind the same caller rules as other Neo operations:
- `pack.preferences.list`, `pack.preferences.get` and `pack.preferences.set`: values are validated against the pack's schema, and setting one records `set_by`.
- `pack.coding.pr.hold` and `pack.coding.pr.release`: release is human or Neo only.

**UI.** Web gets a "Packs" settings panel listing each pack, its scopes (repos for coding) and current values, with edit controls that call the same operations. iOS reads and edits through the same operations. That UI lives in the private neo-ios repo; this doc defines only the contract.

## Tests (what a user can observe)

- **Each policy:** a repo with that policy gets the right nudges for an approved, green PR. `review_bot` and `ci_only` get "merge"; `human` gets none.
- **Sign-off match:** a PR matching `humanSignoff` in a `review_bot` repo shows `waiting_human`, the owner gets no merge text, and the snapshot shows the hold.
- **Lifting:** answering the linked question "yes" lifts the hold and allows the merge nudge; "no" keeps it and tells the owner.
- **First use:** one question per new repo, none after it's answered, and no merge nudges before the answer.
- **qlark#19 replay:** reproduced first. Same timeline with `docs/design/**` held: no merge nudge at +20 min.

## Slices (each about 100–200 production lines, built from fresh dev)

1. **Core preferences.** `NeoPack.preferences` type, the `neo_pack_preferences` migration, repository and lookup.
2. **Operations.** `pack.preferences.*`, plus the one-time seed for the four repos.
3. **Policy-aware ledger state** and `waiting_human`. The qlark#19 replay test is committed failing first.
4. **Holds.** Table, `pack.coding.pr.hold` and `release` operations, the sweep and event skipping held PRs, and the owner told once.
5. **Question link.** The `onQuestionAnswered` core hook and the coding pack lifting holds, plus the linked question on hold creation.
6. **First-use question** for repos with no stored policy.
7. **Web Packs panel**, with the verify-skill journey added in the same PR.
8. **Remove the merge rules from Neo's worker instruction text**, once the daemon enforces them.
