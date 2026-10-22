# Todo state from facts

**Human-approved design (approval relayed by Neo, 2026-10-21). Implementation follows in separate slices after this document merges.** Manual squash merge requires eligible review-bot approval on the exact current head and required green CI; never enable auto-merge. Source audit: `dev` at `e5a63573a8` (2026-10-21). This consumes fullstack-3's [GitHub ledger contract (#8135, `51b3a245`)](https://github.com/lsm/HyperNeo/blob/51b3a2451c22016126ac2d0ef1b0e402e12e4661/docs/design/github-ledger-single-source.md): local reads, coalesced refresh, persisted changes and destination receipts. It does not define that API/schema, refresh GitHub, or add a second collector. Neo coordinates any missing capability before implementation.

## Why the current state drifts

Paths below are relative to `packages/daemon/src/`:

| Current decision | Source |
| --- | --- |
| Mutable `state`/block columns; answers and dispatch mutate them independently. | `storage/repositories/neo-ask-todo-repository.ts:333`, `:365`, `:584` |
| Finish, settle, check, follow/unblock, nudge and refresh update/read their own version of progress. | `lib/neo/todo-runner.ts:263`, `:439`, `:460`, `:525`, `:603`, `:717` |
| Restart loses check/idle/rule memory; ask-idle notices are synthesized again. | `lib/neo/todo-runner.ts:245`, `:260`, `:556`, `:746`; `lib/neo/service.ts:164`, `:373`, `:410` |
| Two stall schedulers; duplicate PR routes are selected by a claim flag. | `lib/neo/todo-runner.ts:168`; `lib/neo/packs/coding/pr-sweep.ts:6`, `:57`; `lib/neo/packs/coding/pr-events.ts:87`, `:110`; `storage/repositories/neo-card-event-subscription-repository.ts:7` |
| Results are inferred through receipt evidence, an 80-character opening match, then an unverified latest reply after three hours. | `lib/neo/driver-work.ts:307`, `:476`, `:541`, `:587` |

## One projection, explicit identity

Keep todo **intent** (owner ask, title, acceptance predicate, required canonical refs, cancellation/replacement) and immutable dispatch/result/acceptance facts. Do not persist `doing`, `blocked`, `done` or copies of their reasons as independently writable truth. A dispatch binds `(todoId, intent revision, dispatch generation, WorkRef)`; a reused worker session is not identity. One projection serves RPC, snapshots, UI, scheduling and post-await checks; return its input revision and reason/source evidence. Administrative removal remains explicit intent.

Apply this precedence to the current intent/generation:

1. **Done:** its configured acceptance predicate is established by covered facts, e.g. every required PR merged into the intended target, or an explicit authorized human acceptance for an uncheckable result. A blocking question must be resolved. A worker's success claim, session idleness or a timer alone cannot certify completion.
2. **Blocked:** a relevant open blocking question, current session `needs_you`/failed/stopped, closed-unmerged prerequisite, or unresolved explicit blocker requires action. A running session clears a worker-stopped reason naturally; it cannot clear a human question. Ledger CI failure normally means work to fix, not a human blocker.
3. **Doing:** an acknowledged dispatch/result/check is in progress or waiting for external facts; expose that phase. An undispatched intent stays `todo`.

Unknown/stale session or ledger coverage is displayed as unknown evidence, never as success or proof a blocker disappeared. Retain established immutable acceptance, without newly certifying done from unknown fields; expire only evidence whose predicate requires current coverage. Missing ledger facts request its coalesced refresh. Needed capabilities, relayed via Neo: canonical identity, PR head/base/merge evidence, immutable revision, observedAt and field-level coverage/incomplete reason, persisted change IDs and destination receipts. Head-scoped checks/reviews must not leak across heads. Worker provenance stays separate from GitHub truth; todo-generation binding belongs here. Capture revisions before awaits and re-read/revalidate the current binding, ask eligibility and acceptance identity before publishing or acting; no sweep cache substitutes for that check.

## One result contract, delivery path and stall ladder

A typed result submission renders **“result for todo X”** and carries todo/generation, authenticated worker identity, an idempotency key, outcome (`progress`, `blocked`, `success`), complete text or an authorized outbox artifact reference/hash, and evidence refs. Accept only the bound worker or an authorized human import. Reject mismatched generations; retain late reports for audit without attaching them to another todo. Success is a proposal until the acceptance predicate holds. Receipt evidence remains transport acknowledgment, not a result fallback: remove all three todo-result inference layers, including substring and three-hour latest-reply adoption. Adapters unable to submit explicitly report unsupported; never invent a final reply or truncate it.

The **ledger's delivery surface is the only PR→worker path**, including CI/review/comments/merge. Todos read those same facts; they do not relay PR events again. Retire `pack_coding_pr_claims` arbitration and per-todo `neo_card_event_subscriptions` routing, including the `claimed` switch. Ambiguous ownership yields a coordination question, never time-based claim guessing. Retry persisted delivery intents with stable event/destination keys; receipts deduplicate replay. Do not promise exactly-once remote delivery after an acknowledgment is lost.

Use one proposed **20/40/60-minute ladder** per no-progress incident: worker reminder, worker reminder, Neo escalation. Replace both the todo 30-minute ladder and state-dependent PR sweep. An incident binds todo/dispatch to its last meaningful progress fact; only relevant `facts_changed` transitions reset it, never `observation_only` revisions. Persist scheduling/delivery receipts so restart cannot reset or duplicate a stage; combine causes into one notice. Questions pause worker nudges; unknown coverage first requests refresh. Age affects attention, never marks done or invents a blocker. Delete `idle`/`checked` maps and `neoAskIdleNote`; dispatch coordination uses durable CAS, not process memory. Replace `savedRules` with existing persisted rule revisions plus durable save/publication receipts, preserving saved-rule acknowledgments without a second in-memory source.

## Migration, verification and small PRs

Each implementation PR targets ~100–200 production lines (repeat a rung if necessary), starts from fresh dev, and carries contracts before code. No GitHub-side implementation overlaps fullstack-3.

1. **Pin:** synthetic projection/identity fixtures and current external behavior, including #8120 resume, stale checks, duplicate events, complete reports and restart.
2. **Build:** additive dispatch/result/acceptance and delivery facts; authenticated result operation; retain existing histories. Backfill explicit bindings and proven historical acceptance with provenance; ambiguous legacy flags produce a migration review item, not fabricated proof.
3. **Wire:** after companion ledger capabilities exist, shadow-compare then atomically select the projection for every reader/action. Reconcile through a fact watermark and disable old publishers together; never run two authoritative state machines. Rollback uses a fact-compatible build, not stale flags.
4. **Wire:** explicit result reporting in worker instructions/adapters, then one persisted stall planner using ledger delivery; restart/replay proof before removing old routes. No concurrent sends from old and new paths.
5. **Delete:** old state mutations, attribution fallbacks, both old ladders, claims/subscriptions, maps and ask-idle note. Remove obsolete live schemas only after preserving provenance/delivery history and auditing all callers; never delete messages, results or backups. Any blocking rebuild needs measurement and a human deploy window first.

CI contracts and a separate verify journey must drive isolated RPC/MCP daemons with synthetic HOME/DB/port: stop→resume, question answer, PR head change/merge, stale/missing ledger data, reused sessions, late/duplicate reports, crash between send/ack, stale post-await edits and restart at each ladder stage. Assert the same projected state/reason everywhere, one logical notice, complete result hashes and retained histories. Measure max lag/RPC/SQL/RSS against 1 s/250 ms, consistent with #7852; no new synchronous hot-path projection scan. This docs-only PR verifies source references and Markdown, and proves no runtime behavior. No real DB copy/write, credentials, GUI, port 8399 or live migration.
